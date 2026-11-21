
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIPE_API = "https://fipe.parallelum.com.br/api/v2";

const vehicleTypes = [
  { type: "car", endpoint: "cars", label: "Carros" },
  { type: "motorcycle", endpoint: "motorcycles", label: "Motos" },
  { type: "truck", endpoint: "trucks", label: "Caminhões" },
] as const;

type FipeBrand = {
  code: string;
  name: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return Response.json(
      { success: false, error: "Método não permitido." },
      { status: 405, headers: corsHeaders },
    );
  }

  let supabase: ReturnType<typeof createClient> | null = null;
  let syncRunId: string | null = null;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Configuração do Supabase incompleta.");
    }

    supabase = createClient(supabaseUrl, supabaseKey);

    const { data: syncRun, error: syncError } = await supabase
      .from("fipe_sync_runs")
      .insert({
        status: "running",
        started_at: new Date().toISOString(),
        source: "FIPE_API",
      })
      .select("id")
      .single();

    if (syncError) throw syncError;

    syncRunId = syncRun.id;

    const results: Record<string, number> = {};
    let totalBrands = 0;

    for (const vehicleType of vehicleTypes) {
      const response = await fetch(
        `${FIPE_API}/${vehicleType.endpoint}/brands`,
        {
          headers: {
            Accept: "application/json",
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `Erro ao consultar ${vehicleType.label}: HTTP ${response.status}`,
        );
      }

      const brands: FipeBrand[] = await response.json();

      if (!Array.isArray(brands)) {
        throw new Error(
          `Resposta inválida da FIPE para ${vehicleType.label}.`,
        );
      }

      const records = brands
        .filter(
          (brand) =>
            brand.code != null &&
            String(brand.code).trim() !== "" &&
            typeof brand.name === "string" &&
            brand.name.trim() !== "",
        )
        .map((brand) => ({
          fipe_brand_code: String(brand.code),
          name: brand.name.trim(),
          vehicle_type: vehicleType.type,
          is_active: true,
        }));

      if (records.length > 0) {
        const { error: upsertError } = await supabase
          .from("vehicle_brands")
          .upsert(records, {
            onConflict: "vehicle_type,fipe_brand_code",
          });

        if (upsertError) throw upsertError;
      }

      results[vehicleType.label] = records.length;
      totalBrands += records.length;
    }

    const { error: updateError } = await supabase
      .from("fipe_sync_runs")
      .update({
        status: "success",
        brands_processed: totalBrands,
        finished_at: new Date().toISOString(),
        details: {
          imported_categories: results,
          source: FIPE_API,
        },
      })
      .eq("id", syncRunId);

    if (updateError) throw updateError;

    return Response.json(
      {
        success: true,
        message: "Marcas FIPE sincronizadas com sucesso.",
        status: "success",
        total_brands: totalBrands,
        categories: results,
        sync_id: syncRunId,
      },
      {
        headers: corsHeaders,
      },
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Erro desconhecido.";

    if (supabase && syncRunId) {
      await supabase
        .from("fipe_sync_runs")
        .update({
          status: "failed",
          error_message: errorMessage,
          finished_at: new Date().toISOString(),
        })
        .eq("id", syncRunId);
    }

    return Response.json(
      {
        success: false,
        error: errorMessage,
        status: "failed",
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
});


import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIPE_API = "https://fipe.parallelum.com.br/api/v2";

const VEHICLE_TYPES = [
  { type: "car", endpoint: "cars" },
  { type: "motorcycle", endpoint: "motorcycles" },
  { type: "truck", endpoint: "trucks" },
];

type FipeModel = {
  codigo: number | string;
  nome: string;
};

type FipeModelsResponse = {
  modelos: FipeModel[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, message: "Use o método POST." }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ success: false, message: "Configuração do Supabase ausente." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let syncId: string | null = null;
  let modelsProcessed = 0;
  let brandsProcessed = 0;

  try {
    const { data: syncRun, error: syncError } = await supabase
      .from("fipe_sync_runs")
      .insert({
        status: "running",
        source: "fipe_parallelum",
        details: { operation: "sync_vehicle_models" },
      })
      .select("id")
      .single();

    if (syncError) throw syncError;
    syncId = syncRun.id;

    const { data: brands, error: brandsError } = await supabase
      .from("vehicle_brands")
      .select("id, fipe_brand_code, vehicle_type")
      .eq("is_active", true)
      .order("vehicle_type")
      .order("name");

    if (brandsError) throw brandsError;
    if (!brands?.length) {
      throw new Error("Nenhuma marca ativa encontrada para sincronizar.");
    }

    const errors: string[] = [];

    for (const brand of brands) {
      const vehicleConfig = VEHICLE_TYPES.find(
        (item) => item.type === brand.vehicle_type,
      );

      if (!vehicleConfig) {
        errors.push(`Tipo de veículo inválido: ${brand.vehicle_type}`);
        continue;
      }

      const url =
        `${FIPE_API}/${vehicleConfig.endpoint}/brands/` +
        `${encodeURIComponent(brand.fipe_brand_code)}/models`;

      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`FIPE respondeu HTTP ${response.status}`);
        }

        const result = await response.json() as FipeModelsResponse;
        const models = result.modelos;

        if (!Array.isArray(models)) {
          throw new Error("Formato inesperado na resposta da FIPE.");
        }

        const rows = models.map((model) => ({
          brand_id: brand.id,
          fipe_model_code: String(model.codigo),
          name: model.nome,
          vehicle_type: brand.vehicle_type,
          is_active: true,
        }));

        if (rows.length > 0) {
          const { error: upsertError } = await supabase
            .from("vehicle_models")
            .upsert(rows, {
              onConflict: "brand_id,fipe_model_code,vehicle_type",
              ignoreDuplicates: false,
            });

          if (upsertError) throw upsertError;
          modelsProcessed += rows.length;
        }

        brandsProcessed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${brand.vehicle_type}/${brand.fipe_brand_code}: ${message}`);
      }

      // Pequena pausa para evitar excesso de requisições à FIPE.
      await wait(150);
    }

    const hasErrors = errors.length > 0;

    const { error: updateError } = await supabase
      .from("fipe_sync_runs")
      .update({
        status: hasErrors ? "completed_with_errors" : "success",
        brands_processed: brandsProcessed,
        models_processed: modelsProcessed,
        finished_at: new Date().toISOString(),
        error_message: hasErrors ? errors.slice(0, 20).join("\n") : null,
        details: {
          operation: "sync_vehicle_models",
          errors_count: errors.length,
          errors: errors.slice(0, 20),
        },
      })
      .eq("id", syncId);

    if (updateError) throw updateError;

    return new Response(
      JSON.stringify({
        success: !hasErrors,
        message: hasErrors
          ? "Sincronização concluída com algumas falhas."
          : "Modelos FIPE sincronizados com sucesso.",
        status: hasErrors ? "completed_with_errors" : "success",
        brands_processed: brandsProcessed,
        models_processed: modelsProcessed,
        errors_count: errors.length,
        errors: errors.slice(0, 10),
        sync_id: syncId,
      }),
      {
        status: hasErrors ? 207 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (syncId) {
      await supabase
        .from("fipe_sync_runs")
        .update({
          status: "failed",
          brands_processed: brandsProcessed,
          models_processed: modelsProcessed,
          finished_at: new Date().toISOString(),
          error_message: message,
        })
        .eq("id", syncId);
    }

    return new Response(
      JSON.stringify({
        success: false,
        message: "Erro ao sincronizar modelos FIPE.",
        error: message,
        sync_id: syncId,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

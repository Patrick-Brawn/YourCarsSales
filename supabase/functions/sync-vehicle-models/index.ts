
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
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;

    return [
      e.message,
      e.details,
      e.hint,
      e.code ? `Código: ${e.code}` : null,
    ]
      .filter(Boolean)
      .join(" | ") || JSON.stringify(error);
  }

  return String(error);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Use o método POST.",
      }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Configuração do Supabase ausente.",
        missing_url: !supabaseUrl,
        missing_service_key: !serviceRoleKey,
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let syncId: string | null = null;
  let modelsProcessed = 0;
  let brandsProcessed = 0;

  const errors: string[] = [];

  try {
    // 1. Registrar início da sincronização.

    const { data: syncRun, error: syncError } = await supabase
      .from("fipe_sync_runs")
      .insert({
        status: "running",
        source: "FIPE_API",
        started_at: new Date().toISOString(),
        details: {
          operation: "sync_vehicle_models",
        },
      })
      .select("id")
      .single();

    if (syncError) {
      throw new Error(
        `Erro ao criar registro de sincronização: ${getErrorMessage(syncError)}`,
      );
    }

    syncId = syncRun.id;

    // 2. Buscar marcas ativas.

    const { data: brands, error: brandsError } = await supabase
      .from("vehicle_brands")
      .select("id, name, fipe_brand_code, vehicle_type")
      .eq("is_active", true)
      .order("vehicle_type")
      .order("name");

    if (brandsError) {
      throw new Error(
        `Erro ao consultar marcas: ${getErrorMessage(brandsError)}`,
      );
    }

    if (!brands || brands.length === 0) {
      throw new Error("Nenhuma marca ativa encontrada.");
    }

    // 3. Consultar os modelos de cada marca.

    for (const brand of brands) {
      const vehicleConfig = VEHICLE_TYPES.find(
        (item) => item.type === brand.vehicle_type,
      );

      if (!vehicleConfig) {
        errors.push(
          `${brand.name}: tipo de veículo inválido (${brand.vehicle_type}).`,
        );
        continue;
      }

      const url =
        `${FIPE_API}/${vehicleConfig.endpoint}/brands/` +
        `${encodeURIComponent(brand.fipe_brand_code)}/models`;

      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          throw new Error(
            `FIPE respondeu HTTP ${response.status}: ${await response.text()}`,
          );
        }

        const result = await response.json() as FipeModelsResponse;

        if (!Array.isArray(result.modelos)) {
          throw new Error("Formato inesperado na resposta da FIPE.");
        }

        const rows = result.modelos.map((model) => ({
          brand_id: brand.id,
          fipe_model_code: String(model.codigo),
          name: model.nome,
          vehicle_type: brand.vehicle_type,
          is_active: true,
        }));

        // 4. Inserir ou atualizar sem incluir campos de imagem.
        // Assim, imagens existentes não são sobrescritas.

        if (rows.length > 0) {
          const { error: upsertError } = await supabase
            .from("vehicle_models")
            .upsert(rows, {
              onConflict: "brand_id,fipe_model_code,vehicle_type",
              ignoreDuplicates: false,
            });

          if (upsertError) {
            throw new Error(getErrorMessage(upsertError));
          }

          modelsProcessed += rows.length;
        }

        brandsProcessed++;

      } catch (error) {
        const message = getErrorMessage(error);

        errors.push(
          `${brand.name} (${brand.vehicle_type}/${brand.fipe_brand_code}): ${message}`,
        );

        console.error("Erro ao sincronizar marca:", {
          brand: brand.name,
          brand_id: brand.id,
          error: message,
        });
      }

      await wait(150);
    }

    // 5. Atualizar histórico da sincronização.

    const hasErrors = errors.length > 0;

    const finalStatus = hasErrors ? "partial" : "success";

    const { error: updateError } = await supabase
      .from("fipe_sync_runs")
      .update({
        status: finalStatus,
        brands_processed: brandsProcessed,
        models_processed: modelsProcessed,
        finished_at: new Date().toISOString(),
        error_message: hasErrors
          ? errors.slice(0, 20).join("\n")
          : null,
        details: {
          operation: "sync_vehicle_models",
          total_brands: brands.length,
          brands_processed: brandsProcessed,
          models_processed: modelsProcessed,
          errors_count: errors.length,
          errors: errors.slice(0, 20),
        },
      })
      .eq("id", syncId);

    if (updateError) {
      throw new Error(
        `Erro ao atualizar histórico: ${getErrorMessage(updateError)}`,
      );
    }

    // 6. Resposta final.

    return new Response(
      JSON.stringify({
        success: !hasErrors,
        message: hasErrors
          ? "Sincronização concluída com algumas falhas."
          : "Modelos FIPE sincronizados com sucesso.",
        status: finalStatus,
        total_brands: brands.length,
        brands_processed: brandsProcessed,
        models_processed: modelsProcessed,
        errors_count: errors.length,
        errors: errors.slice(0, 20),
        sync_id: syncId,
      }),
      {
        status: hasErrors ? 207 : 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );

  } catch (error) {
    const message = getErrorMessage(error);

    console.error("Falha na sincronização de modelos:", message);

    if (syncId) {
      const { error: historyError } = await supabase
        .from("fipe_sync_runs")
        .update({
          status: "failed",
          brands_processed: brandsProcessed,
          models_processed: modelsProcessed,
          finished_at: new Date().toISOString(),
          error_message: message,
          details: {
            operation: "sync_vehicle_models",
            brands_processed: brandsProcessed,
            models_processed: modelsProcessed,
            errors: errors.slice(0, 20),
            fatal_error: message,
          },
        })
        .eq("id", syncId);

      if (historyError) {
        console.error(
          "Erro ao atualizar histórico:",
          getErrorMessage(historyError),
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: false,
        message: "Erro ao sincronizar modelos FIPE.",
        error: message,
        brands_processed: brandsProcessed,
        models_processed: modelsProcessed,
        sync_id: syncId,
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});


-- YOUR SALES CARS
-- MIGRATION 0003
-- SEPARACAO DE FABRICANTES POR TIPO DE VEICULO

ALTER TABLE public.vehicle_brands
ADD COLUMN vehicle_type text NOT NULL DEFAULT 'car'
CHECK (
  vehicle_type IN ('car', 'motorcycle', 'truck')
);

ALTER TABLE public.vehicle_brands
DROP CONSTRAINT vehicle_brands_fipe_brand_code_key;

ALTER TABLE public.vehicle_brands
ADD CONSTRAINT vehicle_brands_type_code_unique
UNIQUE (vehicle_type, fipe_brand_code);

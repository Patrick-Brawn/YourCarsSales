# YOUR SALES CARS

Simulador de concessionária automotiva (React + Vite + Supabase). **Em desenvolvimento por etapas** — veja `docs/PLANO.md`.

## Estado atual: Etapa 1 (fundação)
- Migration `supabase/migrations/0001_core_foundation.sql` (perfis, papéis, configurações, 20 níveis de jogador e de loja, auditoria, RLS).
- Requisitos de nível são **estimativas próprias, não verificadas**, e editáveis (`game_levels`).

## Rodar localmente
1. `cp .env.example .env` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
2. Aplique as migrations no seu projeto Supabase (SQL Editor, ou `supabase db push` com a CLI).
3. `npm install` e `npm run dev`.

## Vercel
Importe o repositório, framework Vite, e defina `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. O `vercel.json` já trata as rotas SPA.

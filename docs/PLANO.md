# YOUR SALES CARS — Arquitetura e plano de desenvolvimento

## Princípios
- Dinheiro em centavos (bigint). Toda operação financeira gera lançamento em `transactions` (livro-razão).
- Escritas sensíveis (compra, venda, comissão, empréstimo, nível, preço) somente por funções SQL `SECURITY DEFINER`, com `FOR UPDATE`/locks e constraints. O frontend nunca escreve saldo, estoque ou preço direto.
- Automação sem navegador: `pg_cron` (Supabase) chama funções SQL (mercado a cada 20 min, vendas automáticas, parcelas). Edge Functions só para integrações externas (FIPE) com `service_role` em secrets.
- Requisitos de nível, parâmetros da economia e critérios de clientes ficam em tabelas editáveis (`game_levels`, `game_settings`, `customer_criteria_config`), cada linha com `is_verified` e `source_note`.
- Limite de ±15% garantido em 3 camadas: CHECK constraint na tabela de preços, função de tick que faz clamp, testes automatizados.

## Etapas
1. **Fundação**: scaffold Vite/React/TS/Tailwind, Supabase client, migration 0001 (perfis, papéis, configuração, 20+ níveis jogador e loja, auditoria, RLS). ← entregue
2. **Catálogo**: fabricantes, modelos, versões, classes (6), carrocerias; seed de 500+ modelos reais (specs ausentes = NULL); preço de referência FIPE (simulado e identificado) e tabela de preços de mercado com CHECK 85–115%.
3. **Auth e shell de UI**: cadastro, login, recuperação de senha, layout com menu lateral/mobile, rotas protegidas, tema escuro, páginas base.
4. **Economia e garagem**: dealerships, estoque, garagem, `transactions`, compra na loja do jogo, venda direta/imediata, painel financeiro, patrimônio/lucro sem dupla contagem, expansão e `try_level_up()` transacional.
5. **Mercado dinâmico**: `market_tick()` (pg_cron, 20 min), histórico, gráficos, indicadores, alertas de preço; integração FIPE via Edge Function (preparada).
6. **Clientes e vendedores**: clientes com critérios configuráveis, compatibilidade, avaliação 1–5 padronizada, VIPs; Time de Vendas (6 por página, atributos 0–100 aleatórios, comissão), contratação/demissão; vendas automáticas no servidor com lock anti-duplicidade.
7. **Banco**: limites, empréstimos (desconto por venda ou parcelas), juros, antecipação/quitação, cron de parcelas.
8. **Marketplace e social**: anúncios, filtros combináveis, comparador (4), favoritos, propostas/contrapropostas, mensagens em tempo real, comunidade, notificações.
9. **Conquistas e rankings**, **painel admin** completo, logs e tarefas agendadas.
10. **Testes e entrega**: testes unitários e de SQL, README, ZIP final.

## Limitações conhecidas (a documentar no README final)
- Requisitos de nível e critérios de clientes NÃO foram verificados contra o stradale.shop (conteúdo não acessível). Valores são estimativas próprias, marcadas `is_verified = false`.
- FIPE: sem fonte externa integrada ainda; valores serão marcados como simulados.

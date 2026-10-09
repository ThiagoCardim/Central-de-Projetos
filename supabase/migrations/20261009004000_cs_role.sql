-- =============================================================================
-- 0040 · Novo tipo de acesso: Customer Success
--   (o valor do enum precisa existir antes de ser usado na migração seguinte)
-- =============================================================================
alter type public.user_role add value if not exists 'customer_success' after 'collaborator';

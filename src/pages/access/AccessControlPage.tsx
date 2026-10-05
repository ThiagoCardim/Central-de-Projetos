import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/services/auth";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { grantableRoles } from "@/permissions";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Avatar, Badge, Button, Card, EmptyState, Field, FilterBar, Input, LoadError,
  SearchInput, Segmented, Select, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { ClientRecord, ClientType, EmploymentType, Profile, Tenant, UserRole } from "@/types/domain";
import {
  CLIENT_TYPE_LABEL, cx, EMPLOYMENT_LABEL, formatDate, RECORD_STATUS_LABEL, ROLE_DESCRIPTION, ROLE_LABEL,
} from "@/utils/format";

type TabKey = "team" | "clients" | "inactive";

export function AccessControlPage() {
  useDocumentTitle("Controle de Acessos");
  const { permissions, profile: me } = useAuth();
  const isGlobal = permissions?.role === "global_admin";
  const mobile = useIsMobile();

  const profiles = useAsync(() => api.listProfiles(), []);
  const tenants = useAsync(() => api.listTenants(), []);
  const tenantById = useMemo(() => new Map((tenants.data ?? []).map((t) => [t.id, t])), [tenants.data]);

  const [tab, setTab] = useState<TabKey>("team");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<"" | UserRole>("");
  const [employment, setEmployment] = useState<"" | EmploymentType | "none">("");
  const [tenantFilter, setTenantFilter] = useState("");
  const [editing, setEditing] = useState<Profile | "new" | null>(null);

  const all = profiles.data ?? [];
  const counts = {
    team: all.filter((p) => p.status === "ativo" && p.role !== "client").length,
    clients: all.filter((p) => p.status === "ativo" && p.role === "client").length,
    inactive: all.filter((p) => p.status === "inativo").length,
  };

  const filtered = all.filter((p) => {
    if (tab === "team" && (p.status !== "ativo" || p.role === "client")) return false;
    if (tab === "clients" && (p.status !== "ativo" || p.role !== "client")) return false;
    if (tab === "inactive" && p.status !== "inativo") return false;
    if (role && p.role !== role) return false;
    if (employment === "none" && p.employment_type) return false;
    if (employment && employment !== "none" && p.employment_type !== employment) return false;
    if (tenantFilter && p.tenant_id !== tenantFilter) return false;
    if (q) {
      const s = q.trim().toLowerCase();
      if (!p.name.toLowerCase().includes(s) && !p.email.toLowerCase().includes(s)) return false;
    }
    return true;
  });
  const hasFilters = !!(q || role || employment || tenantFilter);

  const clearFilters = () => { setQ(""); setRole(""); setEmployment(""); setTenantFilter(""); };

  return (
    <div className="page">
      <PageHead
        title="Controle de Acessos"
        subtitle={isGlobal ? "Usuários de toda a rede YouCon." : `Usuários da unidade ${tenantById.get(me?.tenant_id ?? "")?.name ?? ""}.`}
        actions={<Button icon="userPlus" onClick={() => setEditing("new")}>Convidar usuário</Button>}
      />

      <Tabs<TabKey> label="Tipo de usuário" value={tab} onChange={(v) => { setTab(v); setRole(""); setEmployment(""); }} tabs={[
        { value: "team", label: "Equipe", count: counts.team },
        { value: "clients", label: "Clientes", count: counts.clients },
        { value: "inactive", label: "Inativos", count: counts.inactive },
      ]} />

      <FilterBar active={hasFilters} onClear={clearFilters}>
        <SearchInput placeholder="Buscar por nome ou e-mail" aria-label="Buscar por nome ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
        {tab !== "clients" && (
          <Select aria-label="Perfil" value={role} onChange={(e) => setRole(e.target.value as UserRole | "")}>
            <option value="">Todos os perfis</option>
            {(["collaborator", "leader", "unit_admin", "global_admin"] as UserRole[])
              .filter((r) => isGlobal || r !== "global_admin")
              .map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            {tab === "inactive" && <option value="client">Cliente</option>}
          </Select>
        )}
        {tab !== "clients" && (
          <Select aria-label="Vínculo" value={employment} onChange={(e) => setEmployment(e.target.value as typeof employment)}>
            <option value="">CLT e PJ</option>
            <option value="clt">CLT</option>
            <option value="pj">PJ</option>
            <option value="none">Sem vínculo informado</option>
          </Select>
        )}
        {isGlobal && (
          <Select aria-label="Unidade" value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)}>
            <option value="">Todas as unidades</option>
            {(tenants.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
      </FilterBar>

      {profiles.error ? (
        <LoadError message={profiles.error} onRetry={profiles.reload} />
      ) : profiles.loading && !profiles.data ? (
        <Card flush><div className="stack" style={{ padding: 16 }}>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={36} />)}</div></Card>
      ) : filtered.length === 0 ? (
        <Card>
          {hasFilters ? (
            <EmptyState icon="search" title="Nenhum usuário encontrado com estes filtros."
              action={<Button variant="outline" size="sm" onClick={clearFilters}>Limpar filtros</Button>} />
          ) : tab === "inactive" ? (
            <EmptyState icon="checkCircle" title="Nenhum usuário inativo." text="Usuários desativados perdem o acesso imediatamente e aparecem aqui." />
          ) : tab === "clients" ? (
            <EmptyState icon="user" title="Nenhum cliente com acesso ao portal."
              text="Convide o cliente para que ele acompanhe o andamento do próprio projeto."
              action={<Button variant="secondary" size="sm" icon="userPlus" onClick={() => setEditing("new")}>Convidar cliente</Button>} />
          ) : (
            <EmptyState icon="users" title="Nenhum usuário na equipe ainda."
              text="Convide líderes e colaboradores (CLT ou PJ) para começar a distribuir projetos."
              action={<Button variant="secondary" size="sm" icon="userPlus" onClick={() => setEditing("new")}>Convidar usuário</Button>} />
          )}
        </Card>
      ) : mobile ? (
        <ul className="ucards">
          {filtered.map((p) => (
            <li key={p.id}>
              <button type="button" className={cx("ucard", p.status === "inativo" && "is-inactive")} onClick={() => setEditing(p)}>
                <Avatar name={p.name} src={p.avatar_url} />
                <span className="ident__text grow">
                  <span className="ident__name truncate">{p.name}</span>
                  <span className="ident__sub truncate">{p.email}</span>
                  <span className="row ucard__badges">
                    <Badge>{ROLE_LABEL[p.role]}</Badge>
                    <TypeBadge p={p} />
                    {!p.auth_user_id && <Badge tone="warning">Convite pendente</Badge>}
                  </span>
                </span>
                <Icon name="chevronRight" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Card flush>
          <div className="table-scroll">
            <table className="list">
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Perfil</th>
                  <th>{tab === "clients" ? "Tipo" : "Vínculo"}</th>
                  {isGlobal && <th>Unidade</th>}
                  <th>Situação</th>
                  <th>Convidado em</th>
                  <th className="col-actions"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className={cx("is-clickable", p.status === "inativo" && "is-inactive")} onClick={() => setEditing(p)}>
                    <td>
                      <div className="ident">
                        <Avatar name={p.name} src={p.avatar_url} />
                        <div className="ident__text">
                          <span className="ident__name truncate">{p.name}{p.id === me?.id && <span className="muted"> (você)</span>}</span>
                          <span className="ident__sub truncate">{p.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>{ROLE_LABEL[p.role]}</td>
                    <td><TypeBadge p={p} /></td>
                    {isGlobal && <td className="truncate">{tenantById.get(p.tenant_id)?.name ?? "—"}</td>}
                    <td>
                      {p.status === "inativo" ? <Badge dot>Inativo</Badge>
                        : !p.auth_user_id ? <Badge tone="warning" dot>Convite pendente</Badge>
                        : <Badge tone="success" dot>Ativo</Badge>}
                    </td>
                    <td className="muted num">{formatDate(p.invited_at ?? p.created_at, true)}</td>
                    <td className="col-actions">
                      <Button variant="ghost" size="sm" iconOnly icon="edit"
                        onClick={(e) => { e.stopPropagation(); setEditing(p); }}>
                        {`Editar ${p.name}`}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <UserDrawer
        target={editing}
        tenants={tenants.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void profiles.reload(); }}
        onStatusChanged={() => void profiles.reload()}
      />
    </div>
  );
}

function TypeBadge({ p }: { p: Profile }) {
  if (p.role === "client") return p.client_type ? <Badge tag outline>{CLIENT_TYPE_LABEL[p.client_type]}</Badge> : <span className="muted">—</span>;
  if (p.employment_type) return <Badge tag outline>{EMPLOYMENT_LABEL[p.employment_type]}</Badge>;
  return <span className="muted">—</span>;
}

/* ==========================================================================
   Drawer de convite / edição
   ========================================================================== */
interface FormState {
  name: string;
  email: string;
  phone: string;
  tenant_id: string;
  role: UserRole | "";
  employment_type: EmploymentType | null;
  client_type: ClientType | null;
  client_id: string;          // "" | "new" | uuid
  new_client_name: string;
}

function emptyForm(tenantId: string): FormState {
  return { name: "", email: "", phone: "", tenant_id: tenantId, role: "", employment_type: null, client_type: null, client_id: "", new_client_name: "" };
}

function UserDrawer({ target, tenants, onClose, onSaved, onStatusChanged }: {
  target: Profile | "new" | null;
  tenants: Tenant[];
  onClose: () => void;
  onSaved: () => void;
  onStatusChanged: () => void;
}) {
  const { permissions, profile: me } = useAuth();
  const toast = useToast();
  const isNew = target === "new";
  const editing = target && target !== "new" ? target : null;
  const isSelf = editing?.id === me?.id;

  const [form, setForm] = useState<FormState>(emptyForm(permissions?.tenant_id ?? ""));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    setErrors({}); setServerError(null);
    if (target === "new") setForm(emptyForm(permissions?.tenant_id ?? ""));
    else if (target) setForm({
      name: target.name, email: target.email, phone: target.phone ?? "", tenant_id: target.tenant_id,
      role: target.role, employment_type: target.employment_type, client_type: target.client_type,
      client_id: "", new_client_name: "",
    });
  }, [target, permissions?.tenant_id]);

  const tenant = tenants.find((t) => t.id === form.tenant_id);
  const roles = grantableRoles(permissions, tenant?.type === "franqueadora");
  const isGlobal = permissions?.role === "global_admin";

  const clients = useAsync(
    () => (isNew && form.role === "client" && form.tenant_id ? api.listClients(form.tenant_id) : Promise.resolve([] as ClientRecord[])),
    [isNew, form.role, form.tenant_id],
  );

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  function validate(): boolean {
    const e: typeof errors = {};
    if (form.name.trim().length < 2) e.name = "Informe o nome completo.";
    if (isNew && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) e.email = "Informe um e-mail válido.";
    if (!form.tenant_id) e.tenant_id = "Selecione a unidade.";
    if (!form.role) e.role = "Selecione o perfil de acesso.";
    if (form.role === "collaborator" && !form.employment_type) e.employment_type = "Colaborador precisa ser CLT ou PJ.";
    if (form.role === "client" && !form.client_type) e.client_type = "Indique se o cliente é B2C ou B2B.";
    if (isNew && form.role === "client" && !form.client_id) e.client_id = "Vincule o usuário a um cliente.";
    if (isNew && form.role === "client" && form.client_id === "new" && form.new_client_name.trim().length < 2) e.new_client_name = "Informe o nome do cliente.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSaving(true); setServerError(null);
    try {
      const role = form.role as UserRole;
      if (isNew) {
        let clientId: string | null = null;
        if (role === "client") {
          clientId = form.client_id === "new"
            ? await api.createClient({ tenant_id: form.tenant_id, name: form.new_client_name.trim(), client_type: form.client_type!, email: form.email.trim() })
            : form.client_id;
        }
        await api.inviteUser({
          tenant_id: form.tenant_id, name: form.name.trim(), email: form.email.trim(), role,
          employment_type: role === "client" ? null : form.employment_type,
          client_type: role === "client" ? form.client_type : null,
          client_id: clientId, phone: form.phone.trim() || null,
        });
        toast(`Convite enviado para ${form.email.trim().toLowerCase()}.`);
      } else if (editing) {
        await api.updateUser({
          profile_id: editing.id, name: form.name.trim(), role,
          employment_type: role === "client" ? null : form.employment_type,
          client_type: role === "client" ? form.client_type : null,
          phone: form.phone.trim() || null,
          tenant_id: isGlobal && form.tenant_id !== editing.tenant_id ? form.tenant_id : null,
        });
        toast("Usuário atualizado.");
      }
      onSaved();
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus() {
    if (!editing) return;
    const next = editing.status === "ativo" ? "inativo" : "ativo";
    setStatusSaving(true);
    try {
      await api.setUserStatus(editing.id, next);
      toast(next === "inativo" ? "Usuário desativado." : "Usuário reativado.");
      setConfirmStatus(false);
      onStatusChanged();
      onClose();
    } catch (err) {
      setConfirmStatus(false);
      setServerError((err as Error).message);
    } finally {
      setStatusSaving(false);
    }
  }

  async function resend() {
    if (!editing) return;
    setResending(true);
    try {
      await api.resendInvite(editing.id);
      toast("Convite reenviado.");
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setResending(false);
    }
  }

  const open = target !== null;
  const roleLocked = isSelf; // ninguém altera o próprio papel (o banco também bloqueia)

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={isNew ? "Convidar usuário" : editing?.name ?? ""}
        subtitle={isNew ? "A pessoa recebe um e-mail para criar a senha. Não existe cadastro público."
          : editing ? `${editing.email} · ${RECORD_STATUS_LABEL[editing.status]}` : undefined}
        footer={
          <>
            {editing && !isSelf && (
              editing.status === "ativo"
                ? <Button variant="danger-ghost" icon="userX" onClick={() => setConfirmStatus(true)}>Desativar</Button>
                : <Button variant="outline" icon="refresh" onClick={() => setConfirmStatus(true)}>Reativar</Button>
            )}
            {editing && editing.status === "ativo" && !editing.auth_user_id && (
              <Button variant="ghost" icon="mail" loading={resending} onClick={resend}>Reenviar convite</Button>
            )}
            <span className="spacer" />
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" form="user-form" loading={saving} disabled={editing?.status === "inativo"}>
              {isNew ? "Enviar convite" : "Salvar alterações"}
            </Button>
          </>
        }
      >
        <form id="user-form" className="form" onSubmit={submit} noValidate>
          {serverError && <Alert tone="danger" title="Não foi salvo">{serverError}</Alert>}
          {editing?.status === "inativo" && (
            <Alert tone="warning" title="Usuário inativo">Reative o acesso para editar os dados. Enquanto inativo, a pessoa não consegue entrar.</Alert>
          )}

          <fieldset className="form__group">
            <legend className="label">Identificação</legend>
            <Field label="Nome completo" required error={errors.name}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} value={form.name} onChange={(e) => set("name", e.target.value)} autoComplete="off"
                  aria-describedby={describedBy} aria-invalid={invalid} data-autofocus />
              )}
            </Field>
            <div className="form__cols">
              <Field label="E-mail" required error={errors.email} hint={!isNew ? "O e-mail de acesso não pode ser alterado." : undefined}>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} type="email" value={form.email} disabled={!isNew} autoComplete="off"
                    onChange={(e) => set("email", e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />
                )}
              </Field>
              <Field label="Telefone">
                {({ id }) => <Input id={id} type="tel" inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />}
              </Field>
            </div>
          </fieldset>

          <fieldset className="form__group">
            <legend className="label">Acesso</legend>
            {isGlobal ? (
              <Field label="Unidade" required error={errors.tenant_id}
                hint={!isNew && editing && form.tenant_id !== editing.tenant_id ? "A mudança de unidade será registrada na auditoria." : undefined}>
                {({ id, describedBy, invalid }) => (
                  <Select id={id} value={form.tenant_id} disabled={isSelf}
                    onChange={(e) => { set("tenant_id", e.target.value); set("role", ""); }}
                    aria-describedby={describedBy} aria-invalid={invalid}>
                    <option value="">Selecione</option>
                    {tenants.filter((t) => t.status === "ativo" || t.id === form.tenant_id)
                      .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                )}
              </Field>
            ) : (
              <p className="subtext"><Icon name="building" size={14} className="inline-icon" /> {tenant?.name ?? "Sua unidade"}</p>
            )}

            <div className="roles" role="radiogroup" aria-label="Perfil de acesso" aria-invalid={!!errors.role}>
              {(roles.length ? roles : form.role ? [form.role as UserRole] : []).map((r) => (
                <label key={r} className={cx("role", form.role === r && "is-selected", roleLocked && "is-locked")}>
                  <input type="radio" name="role" value={r} checked={form.role === r} disabled={roleLocked}
                    onChange={() => {
                      set("role", r);
                      if (r === "client") set("employment_type", null);
                      else set("client_type", null);
                    }} />
                  <span className="role__name">{ROLE_LABEL[r]}</span>
                  <span className="role__desc">{ROLE_DESCRIPTION[r]}</span>
                </label>
              ))}
            </div>
            {errors.role && <span className="field__error" role="alert">{errors.role}</span>}
            {roleLocked && <p className="field__hint">Você não pode alterar o próprio perfil de acesso.</p>}
          </fieldset>

          {form.role && form.role !== "client" && (
            <fieldset className="form__group">
              <legend className="label">Vínculo</legend>
              <Field label={form.role === "collaborator" ? "Tipo de contratação" : "Tipo de contratação (opcional)"}
                required={form.role === "collaborator"} error={errors.employment_type}
                hint="PJ não tem acesso a performance, metas CLT ou informações de RH.">
                {({ id }) => (
                  <Segmented<EmploymentType> id={id} label="Tipo de contratação" value={form.employment_type}
                    onChange={(v) => set("employment_type", v)}
                    options={[{ value: "clt", label: "CLT" }, { value: "pj", label: "PJ" }]} />
                )}
              </Field>
            </fieldset>
          )}

          {form.role === "client" && (
            <fieldset className="form__group">
              <legend className="label">Cliente</legend>
              <Field label="Tipo de cliente" required error={errors.client_type}>
                {({ id }) => (
                  <Segmented<ClientType> id={id} label="Tipo de cliente" value={form.client_type}
                    onChange={(v) => set("client_type", v)}
                    options={[{ value: "b2c", label: "B2C · Pessoa física" }, { value: "b2b", label: "B2B · Empresa" }]} />
                )}
              </Field>
              {isNew && (
                <Field label="Vincular ao cliente" required error={errors.client_id}
                  hint="O usuário verá somente os projetos deste cliente.">
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={form.client_id} onChange={(e) => set("client_id", e.target.value)}
                      aria-describedby={describedBy} aria-invalid={invalid} disabled={clients.loading}>
                      <option value="">{clients.loading ? "Carregando clientes…" : "Selecione"}</option>
                      {(clients.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>{c.name} ({CLIENT_TYPE_LABEL[c.client_type]})</option>
                      ))}
                      <option value="new">+ Cadastrar novo cliente</option>
                    </Select>
                  )}
                </Field>
              )}
              {isNew && form.client_id === "new" && (
                <Field label={form.client_type === "b2b" ? "Nome da empresa" : "Nome do cliente"} required error={errors.new_client_name}>
                  {({ id, describedBy, invalid }) => (
                    <Input id={id} value={form.new_client_name} onChange={(e) => set("new_client_name", e.target.value)}
                      aria-describedby={describedBy} aria-invalid={invalid} />
                  )}
                </Field>
              )}
            </fieldset>
          )}
        </form>
      </Drawer>

      <ConfirmDialog
        open={confirmStatus}
        danger={editing?.status === "ativo"}
        loading={statusSaving}
        title={editing?.status === "ativo" ? `Desativar ${editing?.name}?` : `Reativar ${editing?.name}?`}
        message={editing?.status === "ativo"
          ? "O acesso é bloqueado na hora e as sessões abertas são encerradas. O histórico e os vínculos com projetos são preservados. Você pode reativar depois."
          : "A pessoa volta a entrar com a senha atual e recupera o acesso conforme o perfil."}
        confirmLabel={editing?.status === "ativo" ? "Desativar acesso" : "Reativar acesso"}
        onConfirm={changeStatus}
        onCancel={() => setConfirmStatus(false)}
      />
    </>
  );
}

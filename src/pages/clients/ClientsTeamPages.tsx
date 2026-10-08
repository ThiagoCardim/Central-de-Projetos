import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Avatar, Badge, Button, Card, EmptyState, Field, FilterBar, Input, LoadError, SearchInput, Segmented, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { Drawer, Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { OptionPicker } from "@/components/ui/OptionPicker";
import type { ClientListItem, ClientType } from "@/types/domain";
import { CLIENT_TYPE_LABEL, cx, EMPLOYMENT_LABEL, formatDate, ROLE_LABEL } from "@/utils/format";

/* ==========================================================================
   Clientes
   ========================================================================== */
function formatDocument(d: string | null): string {
  if (!d) return "—";
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return d;
}

export function ClientsPage() {
  useDocumentTitle("Clientes");
  const mobile = useIsMobile();
  const { data, error, loading, reload } = useAsync(() => api.listClientsWithProjects(), []);
  const [type, setType] = useState<"all" | ClientType>("all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<ClientListItem | "new" | null>(null);

  const all = data ?? [];
  const list = all.filter((c) => {
    if (type !== "all" && c.client_type !== type) return false;
    if (q) {
      const s = q.toLowerCase();
      const digits = q.replace(/\D/g, "");
      return [c.name, c.email, c.company_name].some((v) => v?.toLowerCase().includes(s)) || (!!digits && !!c.document?.includes(digits));
    }
    return true;
  });

  return (
    <div className="page">
      <PageHead title="Clientes"
        subtitle="Um cliente pode ter vários projetos. Clientes vindos do CRM são criados automaticamente e reconhecidos pelo CPF/CNPJ ou e-mail."
        actions={<Button icon="plus" variant="secondary" onClick={() => setEditing("new")}>Novo cliente</Button>} />
      <Tabs<"all" | ClientType> label="Tipo de cliente" value={type} onChange={setType} tabs={[
        { value: "all", label: "Todos", count: all.length },
        { value: "b2c", label: "B2C", count: all.filter((c) => c.client_type === "b2c").length },
        { value: "b2b", label: "B2B", count: all.filter((c) => c.client_type === "b2b").length },
      ]} />
      <FilterBar active={!!q} onClear={() => setQ("")}>
        <SearchInput placeholder="Buscar por nome, e-mail ou CPF/CNPJ" aria-label="Buscar clientes" value={q} onChange={(e) => setQ(e.target.value)} />
      </FilterBar>

      {error ? <LoadError message={error} onRetry={reload} /> :
       loading && !data ? <Card flush><div className="stack" style={{ padding: 16 }}>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={36} />)}</div></Card> :
       list.length === 0 ? (
        <Card>{all.length === 0
          ? <EmptyState icon="briefcase" title="Nenhum cliente cadastrado."
              text="Clientes são criados automaticamente quando uma venda chega do CRM. Você também pode cadastrar um manualmente." />
          : <EmptyState icon="search" title="Nenhum cliente encontrado." />}</Card>
      ) : mobile ? (
        <ul className="ucards">
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className="ucard" onClick={() => setEditing(c)}>
                <Avatar name={c.name} />
                <span className="ident__text grow">
                  <span className="ident__name truncate">{c.name}</span>
                  <span className="ident__sub truncate">{c.email ?? formatDocument(c.document)}</span>
                  <span className="row ucard__badges"><Badge tag outline>{CLIENT_TYPE_LABEL[c.client_type]}</Badge>
                    <Badge>{c.projects?.[0]?.count ?? 0} projeto(s)</Badge></span>
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
              <thead><tr><th>Cliente</th><th>Tipo</th><th>CPF / CNPJ</th><th>Contato</th><th>Projetos</th><th>Desde</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="is-clickable" onClick={() => setEditing(c)}>
                    <td>
                      <div className="ident">
                        <Avatar name={c.name} />
                        <div className="ident__text">
                          <span className="ident__name truncate">{c.name}</span>
                          {c.company_name && <span className="ident__sub truncate">{c.company_name}</span>}
                        </div>
                      </div>
                    </td>
                    <td><Badge tag outline>{CLIENT_TYPE_LABEL[c.client_type]}</Badge></td>
                    <td className="num muted">{formatDocument(c.document)}</td>
                    <td className="truncate"><span className="ident__text"><span>{c.email ?? "—"}</span><span className="ident__sub">{c.phone ?? ""}</span></span></td>
                    <td className="num">{c.projects?.[0]?.count ?? 0}</td>
                    <td className="num muted">{formatDate(c.created_at, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ClientDrawer target={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />
    </div>
  );
}

function ClientDrawer({ target, onClose, onSaved }: { target: ClientListItem | "new" | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { permissions } = useAuth();
  const isNew = target === "new";
  const c = target && target !== "new" ? target : null;
  const [form, setForm] = useState({ name: "", client_type: null as ClientType | null, email: "", phone: "", document: "", company_name: "" });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setErr(null);
    setForm({ name: c?.name ?? "", client_type: c?.client_type ?? null, email: c?.email ?? "", phone: c?.phone ?? "",
              document: c?.document ?? "", company_name: c?.company_name ?? "" });
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    const digits = form.document.replace(/\D/g, "");
    if (form.name.trim().length < 2) return setErr("Informe o nome do cliente.");
    if (!form.client_type) return setErr("Indique se o cliente é B2C ou B2B.");
    if (digits && digits.length !== 11 && digits.length !== 14) return setErr("CPF deve ter 11 dígitos e CNPJ 14.");
    setSaving(true); setErr(null);
    try {
      await api.saveClient({ id: c?.id, tenant_id: c?.tenant_id ?? permissions!.tenant_id, ...form, client_type: form.client_type, document: digits });
      toast(isNew ? "Cliente cadastrado." : "Cliente atualizado.");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Drawer open={target !== null} onClose={onClose} title={isNew ? "Novo cliente" : c?.name ?? ""}
      subtitle={c ? `${c.projects?.[0]?.count ?? 0} projeto(s) · desde ${formatDate(c.created_at, true)}` : "Para vincular a um usuário do portal, use Controle de Acessos."}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button type="submit" form="client-form" loading={saving}>{isNew ? "Cadastrar cliente" : "Salvar alterações"}</Button></>}>
      <form id="client-form" className="form" onSubmit={submit} noValidate>
        {err && <Alert tone="danger" title="Não foi salvo">{err}</Alert>}
        <Field label="Tipo de cliente" required>
          {({ id }) => <Segmented<ClientType> id={id} label="Tipo de cliente" value={form.client_type}
            onChange={(v) => setForm((f) => ({ ...f, client_type: v }))}
            options={[{ value: "b2c", label: "B2C · Pessoa física" }, { value: "b2b", label: "B2B · Empresa" }]} />}
        </Field>
        <Field label={form.client_type === "b2b" ? "Nome fantasia" : "Nome completo"} required>
          {({ id }) => <Input id={id} value={form.name} onChange={(e) => set("name", e.target.value)} data-autofocus />}
        </Field>
        {form.client_type === "b2b" && (
          <Field label="Razão social">{({ id }) => <Input id={id} value={form.company_name} onChange={(e) => set("company_name", e.target.value)} />}</Field>
        )}
        <Field label={form.client_type === "b2b" ? "CNPJ" : "CPF"} hint="Usado para reconhecer o cliente em novas vendas.">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="numeric" value={form.document} onChange={(e) => set("document", e.target.value)} />}
        </Field>
        <div className="form__cols">
          <Field label="E-mail">{({ id }) => <Input id={id} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />}</Field>
          <Field label="Telefone">{({ id }) => <Input id={id} type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
        </div>
      </form>
    </Drawer>
  );
}

/* ==========================================================================
   Equipe da unidade
   ========================================================================== */
export function TeamPage() {
  useDocumentTitle("Equipe");
  const { permissions } = useAuth();
  const isGlobal = permissions?.role === "global_admin";
  const staff = useAsync(() => api.listProfiles(), []);
  const work = useAsync(() => api.teamWorkload(isGlobal ? null : permissions?.tenant_id ?? null), [isGlobal, permissions?.tenant_id]);
  const tenants = useAsync(() => api.listTenants(), []);
  const [emp, setEmp] = useState<"all" | "clt" | "pj">("all");
  const [sector, setSector] = useState("all");
  const sectors = useAsync(() => api.listSectors(), []);
  const toast = useToast();
  const [sectorOf, setSectorOf] = useState<Record<string, string | null>>({});
  const sectorId = (p: { id: string; sector_id?: string | null }) => (p.id in sectorOf ? sectorOf[p.id] : p.sector_id ?? null);
  const RANK: Record<string, number> = { collaborator: 1, leader: 2, unit_admin: 3, global_admin: 4 };
  const canEditSector = (p: { id: string; role: string }) =>
    !!permissions && (permissions.can_manage_users || (p.id !== permissions.profile_id && RANK[p.role] <= RANK[permissions.role]));
  async function changeSector(p: { id: string; name: string }, familyId: string) { // familyId = id do setor
    const prev = sectorOf[p.id];
    setSectorOf((m) => ({ ...m, [p.id]: familyId || null }));
    try {
      await api.setProfileSector(p.id, familyId || null);
      const name = sectors.data?.find((x) => x.id === familyId)?.name;
      toast(name ? `${p.name} agora é de ${name}.` : `Setor de ${p.name} removido.`);
    } catch (e) {
      setSectorOf((m) => { const n = { ...m }; if (prev === undefined) delete n[p.id]; else n[p.id] = prev; return n; });
      toast((e as Error).message, "error");
    }
  }

  // Funções e descrição (perfil profissional que o cliente vê)
  const jobFns = useAsync(() => api.listJobFunctions(), []);
  const [profOf, setProfOf] = useState<Record<string, { function_ids: string[]; bio: string | null }>>({});
  const profFor = (p: { id: string; function_ids?: string[]; bio?: string | null }) => profOf[p.id] ?? { function_ids: p.function_ids ?? [], bio: p.bio ?? null };
  const fnOptionsFor = (tenantId: string) => (jobFns.data ?? []).filter((f) => f.tenant_id === tenantId)
    .map((f) => ({ value: f.id, label: f.specialty ? `${f.profession} › ${f.specialty}` : f.profession, group: f.profession }));
  const [bioEdit, setBioEdit] = useState<{ id: string; name: string; bio: string } | null>(null);
  const [bioSaving, setBioSaving] = useState(false);
  async function saveProfile(p: { id: string; name: string; function_ids?: string[]; bio?: string | null }, next: { function_ids: string[]; bio: string | null }) {
    const prev = profOf[p.id];
    setProfOf((m) => ({ ...m, [p.id]: next }));
    try { await api.setPersonProfile(p.id, next.function_ids, next.bio); return true; }
    catch (e) {
      setProfOf((m) => { const n = { ...m }; if (prev === undefined) delete n[p.id]; else n[p.id] = prev; return n; });
      toast((e as Error).message, "error"); return false;
    }
  }

  const sectorName = (id: string | null) => (id ? sectors.data?.find((x) => x.id === id)?.name ?? null : null);
  const team = (staff.data ?? []).filter((p) => p.status === "ativo" && p.role !== "client" && p.role !== "global_admin"
    && (emp === "all" || p.employment_type === emp));
  const people = team.filter((p) => sector === "all" || (sector === "none" ? !sectorId(p) : sectorName(sectorId(p)) === sector));
  const withoutSector = team.filter((p) => !sectorId(p)).length;
  const optionsFor = (tenantId: string) => (sectors.data ?? []).filter((x) => x.tenant_id === tenantId).map((x) => ({ value: x.id, label: x.name }));
  const filterNames = [...new Set((sectors.data ?? []).filter((x) => team.some((p) => sectorId(p) === x.id)).map((x) => x.name))];
  const byUser = new Map<string, { id: string; name: string; role: string }[]>();
  (work.data ?? []).forEach((w) => {
    if (!w.project || ["completed", "cancelled"].includes(w.project.status)) return;
    const arr = byUser.get(w.user_id) ?? [];
    if (!arr.some((x) => x.id === w.project!.id)) arr.push({ id: w.project.id, name: w.project.name, role: w.project_role });
    byUser.set(w.user_id, arr);
  });
  const tenantName = (id: string) => tenants.data?.find((t) => t.id === id)?.name ?? "";
  const max = Math.max(1, ...people.map((p) => byUser.get(p.id)?.length ?? 0));

  return (
    <div className="page">
      <PageHead title="Equipe" subtitle="Quem faz parte do time, de qual setor é e em quantos projetos ativos cada pessoa está." />
      <Tabs<"all" | "clt" | "pj"> label="Vínculo" value={emp} onChange={setEmp} tabs={[
        { value: "all", label: "Todos" }, { value: "clt", label: "CLT" }, { value: "pj", label: "PJ" },
      ]} />
      <div className="team-filters">
        <Segmented<string> label="Setor" value={sector} onChange={setSector}
          options={[{ value: "all", label: "Todos os setores" }, ...filterNames.map((n) => ({ value: n, label: n })),
            ...(withoutSector ? [{ value: "none", label: `Sem setor (${withoutSector})` }] : [])]} />
      </div>
      {withoutSector > 0 && sector !== "none" && (
        <Alert tone="warning" title={`${withoutSector} ${withoutSector === 1 ? "pessoa está" : "pessoas estão"} sem setor`}
          action={<Button size="sm" variant="outline" onClick={() => setSector("none")}>Ver quem falta</Button>}>
          O setor define em qual ranking a pessoa entra na Performance e quem concorre ao destaque de cada setor.
        </Alert>
      )}
      {staff.error ? <LoadError message={staff.error} onRetry={staff.reload} /> :
       staff.loading && !staff.data ? <Skeleton height={240} radius={16} /> :
       people.length === 0 ? (
        <Card><EmptyState icon="users" title="Nenhuma pessoa ativa na equipe." text="Convide líderes e colaboradores em Controle de Acessos." /></Card>
      ) : (
        <div className="team-grid">
          {people.map((p) => {
            const projects = byUser.get(p.id) ?? [];
            return (
              <article key={p.id} className="person">
                <header className="ident">
                  <Avatar name={p.name} src={p.avatar_url} size="lg" />
                  <span className="ident__text">
                    <span className="ident__name truncate">{p.name}</span>
                    <span className="ident__sub">{ROLE_LABEL[p.role]}{isGlobal ? ` · ${tenantName(p.tenant_id)}` : ""}</span>
                  </span>
                  {p.employment_type && <Badge tag outline>{EMPLOYMENT_LABEL[p.employment_type]}</Badge>}
                </header>
                <div className="person__sector">
                  <span className="label">Setor</span>
                  <OptionPicker label={`Setor de ${p.name}`} value={sectorId(p) ?? ""} clearable placeholder="Definir setor"
                    options={optionsFor(p.tenant_id)} loading={sectors.loading} disabled={!canEditSector(p)} invalid={!sectorId(p)}
                    emptyText={permissions?.can_manage_tenant ? "Nenhum setor cadastrado. Cadastre em Configurações." : "Nenhum setor cadastrado pela administração."}
                    onChange={(v) => void changeSector(p, v)} />
                </div>
                <div className="person__sector">
                  <span className="label">Funções</span>
                  <OptionPicker label={`Funções de ${p.name}`} multiple value={profFor(p).function_ids} placeholder="Definir funções"
                    options={fnOptionsFor(p.tenant_id)} loading={jobFns.loading} disabled={!canEditSector(p)}
                    emptyText={permissions?.can_manage_tenant ? "Nenhuma função cadastrada. Cadastre em Configurações." : "Nenhuma função cadastrada pela administração."}
                    onChange={(v) => void saveProfile(p, { ...profFor(p), function_ids: v })} />
                </div>
                <div className="person__bio">
                  <span className="label">Sobre (o cliente vê)</span>
                  {profFor(p).bio ? <p className="person__bio-text">{profFor(p).bio}</p> : <p className="subtext person__bio-text">Sem descrição.</p>}
                  {canEditSector(p) && (
                    <button type="button" className="link" onClick={() => setBioEdit({ id: p.id, name: p.name, bio: profFor(p).bio ?? "" })}>
                      {profFor(p).bio ? "Editar descrição" : "Escrever descrição"}
                    </button>
                  )}
                </div>
                <div className="person__load">
                  <span className="label">Projetos ativos</span>
                  <span className="person__count num">{projects.length}</span>
                  <span className="load__bar" aria-hidden="true"><span style={{ width: `${(projects.length / max) * 100}%` }} /></span>
                </div>
                {projects.length > 0 && (
                  <ul className={cx("person__projects")}>
                    {projects.slice(0, 4).map((x) => <li key={x.id} className="truncate">{x.name}</li>)}
                    {projects.length > 4 && <li className="muted">+{projects.length - 4}</li>}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}
      <Modal open={!!bioEdit} onClose={() => setBioEdit(null)} title={`Sobre ${bioEdit?.name ?? ""}`}
        footer={<>
          <Button variant="ghost" onClick={() => setBioEdit(null)}>Cancelar</Button>
          <Button icon="check" loading={bioSaving} onClick={async () => {
            if (!bioEdit) return;
            const person = (staff.data ?? []).find((x) => x.id === bioEdit.id);
            if (!person) return;
            setBioSaving(true);
            const ok = await saveProfile(person, { ...profFor(person), bio: bioEdit.bio.trim() || null });
            setBioSaving(false);
            if (ok) { toast("Descrição salva."); setBioEdit(null); }
          }}>Salvar</Button>
        </>}>
        <Field label="Breve descrição" hint={`Aparece para o cliente em “Equipe do seu projeto”. ${500 - (bioEdit?.bio.length ?? 0)} caracteres restantes.`}>
          {({ id }) => <textarea id={id} className="input textarea" rows={5} maxLength={500} autoFocus
            placeholder="Ex.: Engenheiro civil com 10 anos de experiência em projetos estruturais residenciais."
            value={bioEdit?.bio ?? ""} onChange={(e) => setBioEdit((b) => b && ({ ...b, bio: e.target.value }))} />}
        </Field>
      </Modal>
    </div>
  );
}

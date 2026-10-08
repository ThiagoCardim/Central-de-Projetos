import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { useNavigate } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Badge, Button, Card, EmptyState, Field, FilterBar, Input, LoadError, SearchInput, Segmented, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { OptionPicker, type PickOption } from "@/components/ui/OptionPicker";
import { LocationFields } from "@/components/domain/LocationFields";
import { EMPTY_REASON, ReasonField, reasonIsValid, reasonText, useChangeReasons } from "@/pages/schedule/ReasonField";
import type { ClientType, Intake, IntakeKind } from "@/types/domain";
import {
  CLIENT_TYPE_LABEL, formatDate, formatDateTime, formatMoney, INTAKE_STATUS_LABEL, INTAKE_STATUS_TONE,
} from "@/utils/format";

type TabKey = "attention" | "processed" | "ignored" | "all";

export function IntakePage() {
  useDocumentTitle("Central de Entrada");
  const mobile = useIsMobile();
  const { data, error, loading, reload } = useAsync(() => api.listIntakes(), []);
  const [tab, setTab] = useState<TabKey>("attention");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Intake | "new" | null>(null);

  const all = data ?? [];
  const needsAttention = (i: Intake) => ["error", "received", "validated", "processing"].includes(i.status);
  const counts = {
    attention: all.filter(needsAttention).length,
    processed: all.filter((i) => i.status === "processed").length,
    ignored: all.filter((i) => i.status === "ignored").length,
    all: all.length,
  };
  const list = all.filter((i) => {
    if (tab === "attention" && !needsAttention(i)) return false;
    if (tab === "processed" && i.status !== "processed") return false;
    if (tab === "ignored" && i.status !== "ignored") return false;
    if (q) {
      const s = q.toLowerCase();
      return [i.client_name, i.project_name, i.external_id, i.client_email].some((v) => v?.toLowerCase().includes(s));
    }
    return true;
  });

  return (
    <div className="page">
      <PageHead
        title="Central de Entrada"
        subtitle="Vendas recebidas do CRM. Entradas com erro ficam aqui até serem corrigidas — o projeto só nasce quando tudo está válido."
        actions={<Button icon="plus" variant="secondary" onClick={() => setOpen("new")}>Registrar venda manual</Button>}
      />

      <Tabs<TabKey> label="Situação das entradas" value={tab} onChange={setTab} tabs={[
        { value: "attention", label: "Precisam de atenção", count: counts.attention },
        { value: "processed", label: "Processadas", count: counts.processed },
        { value: "ignored", label: "Ignoradas", count: counts.ignored },
        { value: "all", label: "Todas", count: counts.all },
      ]} />

      <FilterBar active={!!q} onClear={() => setQ("")}>
        <SearchInput placeholder="Buscar por cliente, projeto ou card" aria-label="Buscar entradas" value={q} onChange={(e) => setQ(e.target.value)} />
      </FilterBar>

      {error ? <LoadError message={error} onRetry={reload} /> :
       loading && !data ? (
        <Card flush><div className="stack" style={{ padding: 16 }}>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={40} />)}</div></Card>
      ) : list.length === 0 ? (
        <Card>
          {tab === "attention" && !q ? (
            <EmptyState icon="checkCircle" title="Nenhuma venda precisa de atenção."
              text="Quando o Pipefy enviar uma venda com dados faltando, ela aparecerá aqui para correção." />
          ) : all.length === 0 ? (
            <EmptyState icon="inbox" title="Nenhuma venda recebida ainda."
              text="Assim que um card chegar na fase Ganho do Pipefy, a venda aparece aqui e o projeto é criado automaticamente." />
          ) : (
            <EmptyState icon="search" title="Nenhuma entrada encontrada." />
          )}
        </Card>
      ) : mobile ? (
        <ul className="ucards">
          {list.map((i) => (
            <li key={i.id}>
              <button type="button" className="ucard" onClick={() => setOpen(i)}>
                <span className="ident__text grow">
                  <span className="ident__name truncate">{i.client_name ?? "Cliente não informado"}</span>
                  <span className="ident__sub truncate">{i.project_name ?? "—"} · {formatDateTime(i.received_at)}</span>
                  <span className="row ucard__badges"><IntakeStatusBadge intake={i} /></span>
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
                <tr><th>Cliente</th><th>Projeto</th><th>Serviços</th><th>Origem</th><th>Recebida</th><th>Situação</th></tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} className="is-clickable" onClick={() => setOpen(i)}>
                    <td>
                      <div className="ident__text">
                        <span className="ident__name truncate">{i.client_name ?? <span className="muted">Não informado</span>}</span>
                        <span className="ident__sub">{i.client_type ? CLIENT_TYPE_LABEL[i.client_type] : "Tipo não informado"}
                          {i.intake_kind === "additional_service" ? " · Serviço adicional" : ""}</span>
                      </div>
                    </td>
                    <td className="truncate">{i.project_name ?? <span className="muted">—</span>}</td>
                    <td className="truncate muted">{i.services.length ? i.services.join(", ") : "—"}</td>
                    <td><Badge tag outline>{i.source === "pipefy" ? "Pipefy" : "Manual"}</Badge> <span className="muted subtext num">#{i.external_id.slice(0, 12)}</span></td>
                    <td className="muted num">{formatDateTime(i.received_at)}</td>
                    <td><IntakeStatusBadge intake={i} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <IntakeDrawer target={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />
    </div>
  );
}

function IntakeStatusBadge({ intake }: { intake: Intake }) {
  return <Badge tone={INTAKE_STATUS_TONE[intake.status]} dot>{INTAKE_STATUS_LABEL[intake.status]}</Badge>;
}

/* ==========================================================================
   Drawer: detalhe, correção e reprocessamento / registro manual
   ========================================================================== */
interface IntakeForm {
  intake_kind: IntakeKind;
  target_external_id: string;
  client_name: string;
  client_email: string;
  client_phone: string;
  client_document: string;
  client_type: ClientType | null;
  project_name: string;
  project_type: string;
  services: string;
  contracted_at: string;
  contract_value: string;
  area_m2: string;
  city: string;
  state: string;
  address: string;
  notes: string;
}

function toForm(i: Intake | null): IntakeForm {
  return {
    intake_kind: i?.intake_kind ?? "new_project",
    target_external_id: i?.target_external_id ?? "",
    client_name: i?.client_name ?? "",
    client_email: i?.client_email ?? "",
    client_phone: i?.client_phone ?? "",
    client_document: i?.client_document ?? "",
    client_type: i?.client_type ?? null,
    project_name: i?.project_name ?? "",
    project_type: i?.project_type ?? "",
    services: i?.services?.join(", ") ?? "",
    contracted_at: i?.contracted_at ?? new Date().toISOString().slice(0, 10),
    contract_value: i?.contract_value != null ? String(i.contract_value).replace(".", ",") : "",
    area_m2: i?.area_m2 != null ? String(i.area_m2).replace(".", ",") : "",
    city: i?.city ?? "",
    state: i?.state ?? "",
    address: i?.address ?? "",
    notes: i?.notes ?? "",
  };
}

function IntakeDrawer({ target, onClose, onChanged }: {
  target: Intake | "new" | null; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const { permissions } = useAuth();
  const isNew = target === "new";
  const intake = target && target !== "new" ? target : null;
  const editable = isNew || (intake != null && !["processed", "ignored"].includes(intake.status));
  const [form, setForm] = useState<IntakeForm>(toForm(null));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ignoreReason, setIgnoreReason] = useState(EMPTY_REASON);
  const [ignoreReasons] = useChangeReasons("intake_ignore");
  const [clientId, setClientId] = useState("");
  const saleOptions = useAsync(() => (target ? api.saleServiceOptions() : Promise.resolve([])), [target]);
  const types = useAsync(() => (target ? api.listProjectTypes() : Promise.resolve([])), [target]);
  const commercialTenant = intake?.tenant_id ?? permissions?.tenant_id ?? null;
  const clients = useAsync(() => (target && commercialTenant ? api.clientsForSale(commercialTenant) : Promise.resolve([])), [target, commercialTenant]);
  const projects = useAsync(() => (target && form.intake_kind === "additional_service" ? api.listProjects() : Promise.resolve([])),
    [target, form.intake_kind]);

  useEffect(() => { setForm(toForm(intake)); setServerError(null); setIgnoreReason(EMPTY_REASON); setClientId(""); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- listas pré-definidas ----------
  const serviceList = splitServices(form.services);
  const serviceOptions: PickOption[] = useMemo(() => {
    const opts: PickOption[] = (saleOptions.data ?? []).map((o) => ({
      value: o.name, label: o.name, group: o.group, keywords: o.aliases.join(" "),
      hint: o.kind === "package" ? "pacote" : undefined,
    }));
    const known = new Set(opts.map((o) => o.value.toLowerCase()));
    // Nomes vindos do CRM que não estão no catálogo: aparecem para serem trocados.
    serviceList.filter((s) => !known.has(s.toLowerCase())).forEach((s) => opts.unshift({ value: s, label: s, group: "Não reconhecidos (troque por um do catálogo)" }));
    return opts;
  }, [saleOptions.data, form.services]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectOptions: PickOption[] = useMemo(() => {
    const opts = (projects.data ?? []).filter((p) => p.status !== "cancelled").map((p) => ({
      value: p.code ?? p.id, label: `${p.code ?? "Sem código"} · ${p.name}`, keywords: `${p.client?.name ?? ""} ${p.city ?? ""}`,
      hint: p.client?.name,
    }));
    if (form.target_external_id && !opts.some((o) => o.value === form.target_external_id)) {
      opts.unshift({ value: form.target_external_id, label: `${form.target_external_id} (informado)`, keywords: "", hint: "não encontrado" });
    }
    return opts;
  }, [projects.data, form.target_external_id]);
  const typeOptions: PickOption[] = useMemo(() => {
    const opts = (types.data ?? []).map((t) => ({ value: t.name, label: t.name }));
    if (form.project_type && !opts.some((o) => o.value.toLowerCase() === form.project_type.toLowerCase())) opts.push({ value: form.project_type, label: form.project_type });
    return opts;
  }, [types.data, form.project_type]);
  const clientOptions: PickOption[] = useMemo(() => (clients.data ?? []).map((c) => ({
    value: c.id, label: c.name, keywords: `${c.email ?? ""} ${c.document ?? ""}`, hint: c.email ?? CLIENT_TYPE_LABEL[c.client_type],
  })), [clients.data]);
  function pickClient(id: string) {
    setClientId(id);
    const c = clients.data?.find((x) => x.id === id);
    if (c) setForm((f) => ({ ...f, client_name: c.name, client_type: c.client_type, client_email: c.email ?? "", client_phone: c.phone ?? "", client_document: c.document ?? "" }));
  }
  const lockedClient = !!clientId;

  const set = <K extends keyof IntakeForm>(k: K, v: IntakeForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = intake?.validation_details?.errors ?? (intake?.validation_error ? [intake.validation_error] : []);
  const warnings = intake?.validation_details?.warnings ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setServerError(null);
    try {
      let result;
      if (isNew) {
        result = await api.createManualIntake({
          tipo: form.intake_kind === "additional_service" ? "servico_adicional" : "novo_projeto",
          projeto_referencia: form.target_external_id,
          cliente: { nome: form.client_name, email: form.client_email, telefone: form.client_phone,
                     documento: form.client_document, tipo: form.client_type ?? "" },
          projeto: { nome: form.project_name, tipo: form.project_type, cidade: form.city, uf: form.state,
                     endereco: form.address, area_m2: form.area_m2 },
          servicos: form.services, valor_contrato: form.contract_value,
          data_fechamento: form.contracted_at, observacoes: form.notes,
          tenant_id: permissions?.tenant_id,
        });
      } else if (intake) {
        result = await api.reprocessIntake(intake.id, { ...form, client_type: form.client_type ?? "" });
      }
      onChanged();
      if (result?.status === "processed") {
        toast(isNew ? "Venda registrada e projeto criado." : "Entrada processada. Projeto criado.");
        onClose();
        if (result.project_id) navigate(`/projetos/${result.project_id}`);
      } else {
        setServerError((result?.errors ?? []).join(" ") || "A entrada continua com pendências.");
        toast("Entrada salva com pendências.", "error");
      }
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function ignore() {
    if (!intake) return;
    setSaving(true);
    try {
      await api.ignoreIntake(intake.id, reasonText(ignoreReason, ignoreReasons));
      toast("Entrada ignorada.");
      setIgnoreOpen(false);
      onChanged();
      onClose();
    } catch (err) {
      setIgnoreOpen(false);
      setServerError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Drawer
        open={target !== null}
        onClose={onClose}
        title={isNew ? "Registrar venda manual" : intake?.client_name ?? "Entrada sem cliente"}
        subtitle={isNew ? "Use quando a venda não vier pelo Pipefy. Segue as mesmas validações."
          : intake ? `${intake.source === "pipefy" ? "Pipefy" : "Manual"} · card ${intake.external_id} · recebida ${formatDateTime(intake.received_at)}` : undefined}
        footer={
          <>
            {intake && editable && <Button variant="danger-ghost" onClick={() => setIgnoreOpen(true)}>Ignorar</Button>}
            {intake?.created_project_id && (
              <Button variant="secondary" icon="folder" onClick={() => { onClose(); navigate(`/projetos/${intake.created_project_id}`); }}>
                Abrir projeto
              </Button>
            )}
            <span className="spacer" />
            <Button variant="ghost" onClick={onClose}>{editable ? "Cancelar" : "Fechar"}</Button>
            {editable && (
              <Button type="submit" form="intake-form" loading={saving}>
                {isNew ? "Registrar venda" : "Salvar e reprocessar"}
              </Button>
            )}
          </>
        }
      >
        <form id="intake-form" className="form" onSubmit={submit} noValidate>
          {intake && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <IntakeStatusBadge intake={intake} />
              {intake.processed_at && <span className="subtext">Concluída {formatDateTime(intake.processed_at)}</span>}
            </div>
          )}
          {serverError && <Alert tone="danger" title="Ainda não foi possível criar o projeto">{serverError}</Alert>}
          {!serverError && intake?.status === "error" && errors.length > 0 && (
            <Alert tone="danger" title="O que precisa ser corrigido">{errors.join(" ")}</Alert>
          )}
          {warnings.length > 0 && <Alert tone="warning" title="Avisos">{warnings.join(" ")}</Alert>}

          <fieldset className="form__group" disabled={!editable}>
            <legend className="label">Tipo de venda</legend>
            <Segmented<IntakeKind> label="Tipo de venda" value={form.intake_kind} onChange={(v) => set("intake_kind", v)}
              options={[{ value: "new_project", label: "Novo projeto" }, { value: "additional_service", label: "Serviço adicional" }]} />
            {form.intake_kind === "additional_service" && (
              <Field label="Projeto de referência" required hint="O projeto que recebe o serviço adicional. Busque pelo código, nome ou cliente.">
                {({ id }) => (
                  <OptionPicker id={id} label="Projeto de referência" value={form.target_external_id} loading={projects.loading}
                    options={projectOptions} placeholder="Selecione o projeto" searchPlaceholder="Buscar projeto ou cliente"
                    onChange={(v) => set("target_external_id", v)} />
                )}
              </Field>
            )}
          </fieldset>

          {form.intake_kind === "new_project" && (
            <fieldset className="form__group" disabled={!editable}>
              <legend className="label">Cliente</legend>
              {isNew && (
                <Field label="Cliente já cadastrado?" hint={lockedClient ? "Dados preenchidos do cadastro. Para outro cliente, limpe a seleção." : "Escolha para preencher os dados sem digitar. Em branco: cliente novo."}>
                  {({ id }) => (
                    <OptionPicker id={id} label="Cliente já cadastrado" value={clientId} loading={clients.loading} clearable
                      options={clientOptions} placeholder="Cliente novo" searchPlaceholder="Buscar por nome, e-mail ou CPF/CNPJ"
                      onChange={(v) => { if (v) pickClient(v); else { setClientId(""); setForm((f) => ({ ...f, client_name: "", client_email: "", client_phone: "", client_document: "", client_type: null })); } }} />
                  )}
                </Field>
              )}
              <Field label="Nome do cliente" required>
                {({ id }) => <Input id={id} value={form.client_name} disabled={lockedClient} onChange={(e) => set("client_name", e.target.value)} data-autofocus />}
              </Field>
              <Field label="Tipo de cliente" required>
                {({ id }) => (
                  <Segmented<ClientType> id={id} label="Tipo de cliente" value={form.client_type} onChange={(v) => { if (!lockedClient) set("client_type", v); }}
                    options={[{ value: "b2c", label: "B2C · Pessoa física" }, { value: "b2b", label: "B2B · Empresa" }]} />
                )}
              </Field>
              <div className="form__cols">
                <Field label="E-mail" hint="É o acesso do cliente à plataforma.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="email" disabled={lockedClient} value={form.client_email} onChange={(e) => set("client_email", e.target.value)} />}</Field>
                <Field label="Telefone">{({ id }) => <Input id={id} type="tel" disabled={lockedClient} value={form.client_phone} onChange={(e) => set("client_phone", e.target.value)} />}</Field>
              </div>
              <Field label="CPF / CNPJ" hint="Usado para reconhecer clientes que já existem.">
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="numeric" disabled={lockedClient} value={form.client_document} onChange={(e) => set("client_document", e.target.value)} />}
              </Field>
            </fieldset>
          )}

          <fieldset className="form__group" disabled={!editable}>
            <legend className="label">{form.intake_kind === "new_project" ? "Projeto e contrato" : "Serviços contratados"}</legend>
            <Field label="Serviços" required hint="Selecione um ou mais serviços do catálogo. Pacotes (ex.: Complementares) incluem vários serviços.">
              {({ id }) => (
                <OptionPicker id={id} multiple label="Serviços contratados" value={serviceList} loading={saleOptions.loading}
                  options={serviceOptions} placeholder="Selecione os serviços" searchPlaceholder="Buscar serviço ou pacote"
                  onChange={(v) => set("services", v.join(", "))} />
              )}
            </Field>
            {form.intake_kind === "new_project" && (
              <>
                <div className="form__cols">
                  <Field label="Nome do projeto" hint="Se vazio, usa o nome do cliente.">
                    {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.project_name} onChange={(e) => set("project_name", e.target.value)} />}
                  </Field>
                  <Field label="Tipo do projeto">
                    {({ id }) => (
                      <OptionPicker id={id} label="Tipo do projeto" value={form.project_type} loading={types.loading} clearable
                        options={typeOptions} placeholder="Selecione o tipo" onChange={(v) => set("project_type", v)}
                        searchable={permissions?.role === "global_admin" ? true : undefined}
                        footer={permissions?.role === "global_admin" ? (q, close) => (
                          <NewTypeButton q={q} onCreated={(name) => { void types.reload(); set("project_type", name); close(); }} />
                        ) : undefined} />
                    )}
                  </Field>
                </div>
                <LocationFields city={form.city} state={form.state}
                  onChange={(v) => setForm((f) => ({ ...f, city: v.city, state: v.state }))} />
                <Field label="Endereço">{({ id }) => <Input id={id} value={form.address} onChange={(e) => set("address", e.target.value)} />}</Field>
                <Field label="Área (m²)" hint="Deixe em branco se não souber — nunca assumimos um valor.">
                  {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={form.area_m2} onChange={(e) => set("area_m2", e.target.value)} />}
                </Field>
              </>
            )}
            <div className="form__cols">
              <Field label="Data de fechamento">{({ id }) => <Input id={id} type="date" value={form.contracted_at ?? ""} onChange={(e) => set("contracted_at", e.target.value)} />}</Field>
              <Field label="Valor do contrato">{({ id }) => <Input id={id} inputMode="decimal" placeholder="R$" value={form.contract_value} onChange={(e) => set("contract_value", e.target.value)} />}</Field>
            </div>
            <Field label="Observações">{({ id }) => <textarea id={id} className="input textarea" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />}</Field>
          </fieldset>

          {intake && (
            <details className="raw">
              <summary>Dados originais recebidos do CRM</summary>
              <pre>{JSON.stringify(intake.raw_payload, null, 2)}</pre>
              <p className="subtext">Os dados originais nunca são alterados. As correções acima ficam registradas na auditoria.</p>
            </details>
          )}
          {intake?.status === "processed" && intake.contract_value != null && (
            <p className="subtext">Valor do contrato: {formatMoney(intake.contract_value)} · fechamento {formatDate(intake.contracted_at, true)}</p>
          )}
        </form>
      </Drawer>

      <ConfirmDialog
        open={ignoreOpen}
        danger
        loading={saving}
        title="Ignorar esta entrada?"
        message={
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>Nenhum projeto será criado. A entrada continua registrada para consulta.</p>
            <ReasonField value={ignoreReason} onChange={setIgnoreReason} reasons={ignoreReasons} label="Motivo" showVisibility={false}
              hint="Fica registrado na entrada." />
          </div>
        }
        confirmLabel="Ignorar entrada"
        confirmDisabled={!reasonIsValid(ignoreReason, ignoreReasons)}
        onConfirm={ignore}
        onCancel={() => setIgnoreOpen(false)}
      />
    </>
  );
}

const splitServices = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Rodapé do seletor de tipo: cadastra um tipo novo (ADM Global). */
function NewTypeButton({ q, onCreated }: { q: string; onCreated: (name: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const name = q.trim();
  return (
    <button type="button" className="opick-pop__add" disabled={busy || name.length < 2}
      title={name.length < 2 ? "Digite o nome do novo tipo na busca" : undefined}
      onClick={async () => {
        setBusy(true);
        try { const t = await api.saveProjectType({ name }); toast(`Tipo “${t.name}” adicionado à lista.`); onCreated(t.name); }
        catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
      }}>
      <Icon name="plus" size={16} /> {name.length >= 2 ? <>Adicionar “{name}” à lista</> : "Para adicionar um tipo, digite o nome na busca"}
    </button>
  );
}

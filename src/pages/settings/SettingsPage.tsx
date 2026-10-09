import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle } from "@/hooks";
import { useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import { Button, Card, EmptyState, Field, Input, LoadError, Skeleton, Tabs } from "@/components/ui/primitives";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { OptionPicker } from "@/components/ui/OptionPicker";
import type { JobFunctionRow, PerfSettings, SectorRow } from "@/types/domain";
import { plural } from "@/utils/format";
import { FaqSettings } from "./FaqSettings";
import { CsSettingsPanel } from "./CsSettings";
import { SupportSettingsPanel } from "./SupportSettings";

/* ==========================================================================
   Configurações (administração): setores da empresa e regras de performance
   ========================================================================== */
type Tab = "setores" | "funcoes" | "performance" | "cs" | "atendimento" | "faq";

export function SettingsPage() {
  useDocumentTitle("Configurações");
  const { permissions } = useAuth();
  const isGlobal = permissions?.role === "global_admin";
  const initial = useSearchParam("aba") as Tab | null;
  // O FAQ é único para toda a rede: só a administração global edita.
  const canFaq = !!permissions?.can_manage_tenants;
  const [tab, setTab] = useState<Tab>(initial === "performance" || initial === "funcoes" || initial === "cs" || initial === "atendimento" || (initial === "faq" && canFaq) ? initial : "setores");
  const [tenant, setTenant] = useState(permissions?.tenant_id ?? "");
  const tenants = useAsync(() => (isGlobal ? api.listTenants() : Promise.resolve([])), [isGlobal]);

  return (
    <div className="page settings">
      <PageHead title="Configurações" subtitle="Definições da administração para a unidade" />
      <div className="settings__bar">
        <Tabs<Tab> label="Configurações" value={tab} onChange={setTab} tabs={[
          { value: "setores", label: "Setores" }, { value: "funcoes", label: "Funções" }, { value: "performance", label: "Regras de performance" },
          { value: "cs", label: "Customer Success" }, { value: "atendimento", label: "Atendimento ao cliente" },
          ...(canFaq ? [{ value: "faq" as Tab, label: "FAQ" }] : []),
        ]} />
        {isGlobal && tab !== "faq" && (
          <div className="settings__unit">
            <OptionPicker label="Unidade" value={tenant} loading={tenants.loading}
              options={(tenants.data ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => v && setTenant(v)} />
          </div>
        )}
      </div>
      {tab === "faq" ? <FaqSettings /> : tenant && (tab === "setores" ? <SectorsSettings key={tenant} tenantId={tenant} />
        : tab === "funcoes" ? <FunctionsSettings key={tenant} tenantId={tenant} />
        : tab === "cs" ? <CsSettingsPanel key={tenant} tenantId={tenant} />
        : tab === "atendimento" ? <SupportSettingsPanel key={tenant} tenantId={tenant} />
        : <PerformanceRules key={tenant} tenantId={tenant} />)}
    </div>
  );
}

/* ---------- Setores ---------- */
function SectorsSettings({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const q = useAsync(() => api.sectorList(tenantId), [tenantId]);
  const [rows, setRows] = useState<SectorRow[]>([]);
  useEffect(() => { if (q.data) setRows(q.data); }, [q.data]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<SectorRow | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setBusy(true);
    try { await api.sectorSave(tenantId, null, name.trim()); setName(""); toast("Setor incluído."); await q.reload(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function rename() {
    if (!editing || editing.name.trim().length < 2) return;
    setBusy(true);
    try { await api.sectorSave(null, editing.id, editing.name.trim()); setEditing(null); toast("Setor renomeado."); await q.reload(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows]; [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
    try { await api.sectorReorder(tenantId, next.map((r) => r.id)); }
    catch (err) { setRows(rows); toast((err as Error).message, "error"); }
  }
  async function remove(r: SectorRow) {
    setBusy(true);
    try {
      const n = await api.sectorDelete(r.id);
      toast(n ? `Setor excluído. ${plural(n, "pessoa ficou", "pessoas ficaram")} sem setor.` : "Setor excluído.");
      setRemoving(null); await q.reload();
    } catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <div className="settings__grid">
      <Card title="Setores da empresa" count={rows.length || undefined} flush>
        {q.error ? <div className="settings__pad"><LoadError message={q.error} onRetry={() => void q.reload()} /></div> :
          q.loading && !q.data ? <div className="settings__pad"><Skeleton height={160} radius={12} /></div> :
          rows.length === 0 ? <EmptyState compact icon="layers" title="Nenhum setor cadastrado." text="Inclua abaixo os setores que existem na empresa." /> : (
            <ul className="sectors">
              {rows.map((r, i) => (
                <li key={r.id} className="sector">
                  <span className="sector__order">
                    <Button size="sm" variant="ghost" iconOnly icon="chevronDown" className="flip" disabled={i === 0} onClick={() => move(i, -1)}>Subir {r.name}</Button>
                    <Button size="sm" variant="ghost" iconOnly icon="chevronDown" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>Descer {r.name}</Button>
                  </span>
                  {editing?.id === r.id ? (
                    <form className="sector__edit" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                      <Input aria-label="Nome do setor" autoFocus value={editing.name} maxLength={60}
                        onChange={(e) => setEditing({ id: r.id, name: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
                      <Button size="sm" type="submit" icon="check" loading={busy}>Salvar</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
                    </form>
                  ) : (
                    <>
                      <span className="sector__name">{r.name}</span>
                      <span className="sector__people">{r.people ? plural(r.people, "pessoa", "pessoas") : "Ninguém ainda"}</span>
                      <span className="sector__actions">
                        <Button size="sm" variant="ghost" iconOnly icon="edit" onClick={() => setEditing({ id: r.id, name: r.name })}>Renomear {r.name}</Button>
                        <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setRemoving(r)}>Excluir {r.name}</Button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        <form className="sector__add" onSubmit={add}>
          <Input aria-label="Novo setor" placeholder="Nome do novo setor" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" icon="plus" loading={busy && !editing} disabled={name.trim().length < 2}>Incluir setor</Button>
        </form>
      </Card>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Para que servem</h3>
        <p>Cada pessoa da equipe pertence a um setor. Ele define em qual ranking a pessoa aparece na Performance e quem concorre ao destaque do mês de cada setor.</p>
        <p>O setor de cada pessoa é escolhido na aba <b>Equipe</b> (ou no cadastro do usuário). A ordem desta lista é a ordem em que os setores aparecem nas telas.</p>
        <p>Ao excluir um setor, as pessoas dele ficam <b>sem setor</b> até serem realocadas. Nenhum dado de entregas é perdido.</p>
      </aside>
      <ConfirmDialog open={!!removing} danger title={`Excluir o setor “${removing?.name ?? ""}”?`}
        message={removing?.people ? `${plural(removing.people, "pessoa ficará", "pessoas ficarão")} sem setor até serem realocadas na Equipe.` : "Nenhuma pessoa está neste setor."}
        confirmLabel="Excluir setor" loading={busy} onCancel={() => setRemoving(null)} onConfirm={() => removing && remove(removing)} />
    </div>
  );
}

/* ---------- Funções ---------- */
const fnLabel = (f: { profession: string; specialty: string | null }) => (f.specialty ? `${f.profession} › ${f.specialty}` : f.profession);

function FunctionsSettings({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const q = useAsync(() => api.jobFunctionList(tenantId), [tenantId]);
  const [rows, setRows] = useState<JobFunctionRow[]>([]);
  useEffect(() => { if (q.data) setRows(q.data); }, [q.data]);
  const [prof, setProf] = useState("");
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; profession: string; specialty: string } | null>(null);
  const [removing, setRemoving] = useState<JobFunctionRow | null>(null);
  const professions = [...new Set(rows.map((r) => r.profession))];

  async function add(e: FormEvent) {
    e.preventDefault();
    if (prof.trim().length < 2) return;
    setBusy(true);
    try { await api.jobFunctionSave(tenantId, null, prof.trim(), spec.trim() || null); setSpec(""); toast("Função incluída."); await q.reload(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function rename() {
    if (!editing || editing.profession.trim().length < 2) return;
    setBusy(true);
    try { await api.jobFunctionSave(null, editing.id, editing.profession.trim(), editing.specialty.trim() || null); setEditing(null); toast("Função atualizada."); await q.reload(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows]; [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
    try { await api.jobFunctionReorder(tenantId, next.map((r) => r.id)); }
    catch (err) { setRows(rows); toast((err as Error).message, "error"); }
  }
  async function remove(r: JobFunctionRow) {
    setBusy(true);
    try {
      const n = await api.jobFunctionDelete(r.id);
      toast(n ? `Função excluída e retirada de ${plural(n, "pessoa", "pessoas")}.` : "Função excluída.");
      setRemoving(null); await q.reload();
    } catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <div className="settings__grid">
      <Card title="Funções da equipe" count={rows.length || undefined} flush>
        {q.error ? <div className="settings__pad"><LoadError message={q.error} onRetry={() => void q.reload()} /></div> :
          q.loading && !q.data ? <div className="settings__pad"><Skeleton height={160} radius={12} /></div> :
          rows.length === 0 ? <EmptyState compact icon="user" title="Nenhuma função cadastrada." text="Inclua abaixo as funções da equipe." /> : (
            <ul className="sectors">
              {rows.map((r, i) => (
                <li key={r.id} className="sector">
                  <span className="sector__order">
                    <Button size="sm" variant="ghost" iconOnly icon="chevronDown" className="flip" disabled={i === 0} onClick={() => move(i, -1)}>Subir {fnLabel(r)}</Button>
                    <Button size="sm" variant="ghost" iconOnly icon="chevronDown" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>Descer {fnLabel(r)}</Button>
                  </span>
                  {editing?.id === r.id ? (
                    <form className="sector__edit" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                      <Input aria-label="Profissão" autoFocus value={editing.profession} maxLength={40} list="fn-professions"
                        onChange={(e) => setEditing({ ...editing, profession: e.target.value })} />
                      <Input aria-label="Especialidade" placeholder="Especialidade (opcional)" value={editing.specialty} maxLength={60}
                        onChange={(e) => setEditing({ ...editing, specialty: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
                      <Button size="sm" type="submit" icon="check" loading={busy}>Salvar</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
                    </form>
                  ) : (
                    <>
                      <span className="sector__name">{r.profession}{r.specialty && <span className="fn__spec"> › {r.specialty}</span>}</span>
                      <span className="sector__people">{r.people ? plural(r.people, "pessoa", "pessoas") : "Ninguém ainda"}</span>
                      <span className="sector__actions">
                        <Button size="sm" variant="ghost" iconOnly icon="edit" onClick={() => setEditing({ id: r.id, profession: r.profession, specialty: r.specialty ?? "" })}>Editar {fnLabel(r)}</Button>
                        <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setRemoving(r)}>Excluir {fnLabel(r)}</Button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        <form className="sector__add" onSubmit={add}>
          <Input aria-label="Profissão" placeholder="Profissão (ex.: Engenheiro)" value={prof} maxLength={40} list="fn-professions" onChange={(e) => setProf(e.target.value)} />
          <Input aria-label="Especialidade" placeholder="Especialidade (ex.: Estrutural)" value={spec} maxLength={60} onChange={(e) => setSpec(e.target.value)} />
          <Button type="submit" icon="plus" loading={busy && !editing} disabled={prof.trim().length < 2}>Incluir função</Button>
        </form>
        <datalist id="fn-professions">{professions.map((p) => <option key={p} value={p} />)}</datalist>
      </Card>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Para que servem</h3>
        <p>A função diz o que a pessoa faz: <b>Profissão › Especialidade</b>, como Engenheiro › Estrutural ou Arquiteto › Interiores. A especialidade é opcional.</p>
        <p>Uma pessoa pode ter várias funções (ex.: o mesmo engenheiro faz o Elétrico e o Hidráulico). Elas são marcadas na aba <b>Equipe</b>.</p>
        <p>As funções aparecem para o cliente em <b>Equipe do seu projeto</b>, junto com a descrição da pessoa.</p>
      </aside>
      <ConfirmDialog open={!!removing} danger title={`Excluir a função “${removing ? fnLabel(removing) : ""}”?`}
        message={removing?.people ? `Ela será retirada de ${plural(removing.people, "pessoa", "pessoas")}.` : "Nenhuma pessoa tem esta função."}
        confirmLabel="Excluir função" loading={busy} onCancel={() => setRemoving(null)} onConfirm={() => removing && remove(removing)} />
    </div>
  );
}

/* ---------- Regras da nota de performance ---------- */
function PerformanceRules({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const q = useAsync(() => api.performanceSettings(tenantId), [tenantId]);
  const [v, setV] = useState<PerfSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!v) return <Skeleton height={320} radius={16} />;

  const total = v.weight_delivery + v.weight_on_time + v.weight_no_backlog;
  const num = (k: keyof PerfSettings, min: number, max: number) => ({
    type: "number" as const, min, max, value: String(v[k] as number),
    onChange: (e: ChangeEvent<HTMLInputElement>) => setV((x) => x && ({ ...x, [k]: Math.max(min, Math.min(max, Number(e.target.value) || 0)) })),
  });
  const invalid = total <= 0 ? "Defina ao menos um peso maior que zero." : v.band_great <= v.band_ok ? "A faixa “acima do esperado” precisa ser maior que a “satisfatória”." : null;
  const dirty = JSON.stringify(v) !== JSON.stringify(q.data);

  async function save() {
    if (invalid || !v) return;
    setSaving(true);
    try {
      const { tenant_id: _t, ...rest } = v; void _t;
      await api.savePerformanceSettings(tenantId, rest); toast("Regras da nota atualizadas."); await q.reload();
    } catch (e) { toast((e as Error).message, "error"); } finally { setSaving(false); }
  }

  return (
    <div className="settings__grid">
      <Card title="Regras da nota de performance">
        <div className="stack pset">
          <section>
            <h3 className="pset__title">Pesos da nota</h3>
            <p className="subtext">Quanto cada parte vale na nota final. Os pesos são proporcionais (a soma não precisa dar 100).</p>
            <div className="pset__grid">
              <Field label="Cumprimento">{({ id }) => <Input id={id} {...num("weight_delivery", 0, 100)} />}</Field>
              <Field label="Pontualidade">{({ id }) => <Input id={id} {...num("weight_on_time", 0, 100)} />}</Field>
              <Field label="Sem atrasos em aberto">{({ id }) => <Input id={id} {...num("weight_no_backlog", 0, 100)} />}</Field>
            </div>
          </section>
          <section>
            <h3 className="pset__title">Faixas</h3>
            <div className="pset__grid">
              <Field label="Satisfatório a partir de" hint="Abaixo disso: abaixo do esperado.">{({ id }) => <Input id={id} {...num("band_ok", 1, 150)} />}</Field>
              <Field label="Acima do esperado a partir de">{({ id }) => <Input id={id} {...num("band_great", 1, 150)} />}</Field>
            </div>
          </section>
          <section>
            <h3 className="pset__title">Ranking e destaques</h3>
            <div className="pset__grid">
              <Field label="Mínimo de entregas previstas" hint="Para concorrer ao destaque do setor no mês.">{({ id }) => <Input id={id} {...num("min_volume", 0, 200)} />}</Field>
            </div>
            <label className="pset__check">
              <input type="checkbox" checked={v.include_assigned_tasks} onChange={(e) => setV((x) => x && ({ ...x, include_assigned_tasks: e.target.checked }))} />
              <span><b>Contar as tarefas atribuídas pela liderança</b><small>Além das etapas dos projetos. Tarefas pessoais nunca contam.</small></span>
            </label>
            <label className="pset__check">
              <input type="checkbox" checked={v.highlight_includes_pj} onChange={(e) => setV((x) => x && ({ ...x, highlight_includes_pj: e.target.checked }))} />
              <span><b>Colaboradores PJ concorrem ao destaque</b><small>A performance do PJ é medida e aparece para a gestão, mas nunca para o próprio PJ. Deixe desmarcado se o destaque for divulgado ao time.</small></span>
            </label>
          </section>
          {invalid && <p className="field__error" role="alert">{invalid}</p>}
          <div className="settings__save">
            <Button variant="ghost" disabled={!dirty || saving} onClick={() => setV(q.data ?? null)}>Desfazer</Button>
            <Button icon="check" loading={saving} disabled={!!invalid || !dirty} onClick={save}>Salvar regras</Button>
          </div>
        </div>
      </Card>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como a nota funciona</h3>
        <p><b>Cumprimento</b>: entregas feitas no mês ÷ previstas no mês.</p>
        <p><b>Pontualidade</b>: entregas feitas até o prazo ÷ entregas feitas.</p>
        <p><b>Sem atrasos em aberto</b>: quanto menos itens vencidos e não entregues, maior.</p>
        <p>As mudanças valem para todos os meses exibidos na Performance desta unidade.</p>
      </aside>
    </div>
  );
}

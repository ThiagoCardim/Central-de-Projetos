import { LocationFields } from "@/components/domain/LocationFields";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/services/auth";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle } from "@/hooks";
import { PageHead } from "@/layouts/AppLayout";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LoadError, Skeleton } from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { TenantOverview } from "@/types/domain";
import { cx, formatDate, slugify, TENANT_TYPE_LABEL } from "@/utils/format";

const UF = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

export function UnitsPage() {
  useDocumentTitle("Unidades");
  const { permissions } = useAuth();
  const isGlobal = !!permissions?.can_manage_tenants;
  const { data, error, loading, reload } = useAsync(() => api.tenantOverview(), []);
  const [editing, setEditing] = useState<TenantOverview | "new" | null>(null);

  const units = data ?? [];
  const franchises = units.filter((u) => u.type === "franquia");

  return (
    <div className="page">
      <PageHead
        title="Unidades"
        subtitle={isGlobal
          ? "Franqueadora e franquias. Cada unidade opera com usuários, clientes e projetos isolados."
          : "Dados da sua unidade."}
        actions={isGlobal ? <Button icon="plus" onClick={() => setEditing("new")}>Nova franquia</Button> : undefined}
      />

      {error ? <LoadError message={error} onRetry={reload} /> :
       loading && !data ? (
        <div className="units">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} height={168} radius={16} />)}</div>
      ) : (
        <>
          <div className="units">
            {units.map((u) => (
              <UnitCard key={u.tenant_id} unit={u} canEdit={isGlobal || permissions?.tenant_id === u.tenant_id}
                onEdit={() => setEditing(u)} />
            ))}
          </div>
          {isGlobal && franchises.length === 0 && (
            <Card>
              <EmptyState icon="building" title="Nenhuma franquia cadastrada."
                text="Enquanto não houver franquias, todos os projetos são executados pela Franqueadora automaticamente."
                action={<Button variant="secondary" size="sm" icon="plus" onClick={() => setEditing("new")}>Cadastrar franquia</Button>} />
            </Card>
          )}
        </>
      )}

      <UnitDrawer target={editing} isGlobal={isGlobal} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void reload(); }} />
    </div>
  );
}

function UnitCard({ unit: u, canEdit, onEdit }: { unit: TenantOverview; canEdit: boolean; onEdit: () => void }) {
  return (
    <article className={cx("unit", u.status === "inativo" && "is-inactive")}>
      <header className="unit__head">
        <span className="unit__icon"><Icon name="building" /></span>
        <div className="grow">
          <h2 className="unit__name truncate">{u.name}</h2>
          <p className="subtext">
            {TENANT_TYPE_LABEL[u.type]}
            {u.city ? ` · ${u.city}${u.state ? `/${u.state}` : ""}` : ""}
          </p>
        </div>
        {u.status === "inativo" ? <Badge dot>Inativa</Badge> : <Badge tone="success" dot>Ativa</Badge>}
      </header>
      <dl className="unit__stats">
        <div><dt className="label">Projetos ativos</dt><dd className="num">{u.projects_active}</dd></div>
        <div><dt className="label">Aguardando</dt><dd className={cx("num", u.projects_awaiting > 0 && "text-brand")}>{u.projects_awaiting}</dd></div>
        <div><dt className="label">Equipe</dt><dd className="num">{u.users_active}</dd></div>
        <div><dt className="label">CLT / PJ</dt><dd className="num">{u.collaborators_clt} / {u.collaborators_pj}</dd></div>
        <div><dt className="label">Clientes</dt><dd className="num">{u.clients}</dd></div>
      </dl>
      <footer className="unit__foot">
        <span className="subtext muted">Desde {formatDate(u.created_at, true)}</span>
        {canEdit && <Button variant="ghost" size="sm" icon="edit" onClick={onEdit}>Editar</Button>}
      </footer>
    </article>
  );
}

function UnitDrawer({ target, isGlobal, onClose, onSaved }: {
  target: TenantOverview | "new" | null; isGlobal: boolean; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const isNew = target === "new";
  const unit = target && target !== "new" ? target : null;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setErrors({}); setServerError(null); setSlugTouched(false);
    setName(unit?.name ?? ""); setSlug(""); setCity(unit?.city ?? ""); setState(unit?.state ?? "");
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = "Informe o nome da unidade.";
    const finalSlug = slugTouched ? slug : slugify(name);
    if (isNew && !/^[a-z0-9-]{2,60}$/.test(finalSlug)) errs.slug = "Use letras minúsculas, números e hífen.";
    if (state && !UF.includes(state)) errs.state = "UF inválida.";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSaving(true); setServerError(null);
    try {
      if (isNew) {
        await api.createTenant({ name: name.trim(), slug: finalSlug, city: city.trim() || null, state: state || null });
        toast("Franquia cadastrada.");
      } else if (unit) {
        await api.updateTenant(unit.tenant_id, { name: name.trim(), city: city.trim() || null, state: state || null });
        toast("Unidade atualizada.");
      }
      onSaved();
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus() {
    if (!unit) return;
    setSaving(true);
    try {
      await api.updateTenant(unit.tenant_id, { status: unit.status === "ativo" ? "inativo" : "ativo" });
      toast(unit.status === "ativo" ? "Unidade desativada." : "Unidade reativada.");
      setConfirm(false);
      onSaved();
    } catch (err) {
      setConfirm(false);
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
        title={isNew ? "Nova franquia" : unit?.name ?? ""}
        subtitle={isNew ? "A unidade nasce sem usuários. Depois, convide o ADM da unidade em Controle de Acessos." : unit ? TENANT_TYPE_LABEL[unit.type] : undefined}
        footer={
          <>
            {unit && isGlobal && unit.type === "franquia" && (
              unit.status === "ativo"
                ? <Button variant="danger-ghost" onClick={() => setConfirm(true)}>Desativar unidade</Button>
                : <Button variant="outline" onClick={() => setConfirm(true)}>Reativar unidade</Button>
            )}
            <span className="spacer" />
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" form="unit-form" loading={saving}>{isNew ? "Cadastrar franquia" : "Salvar alterações"}</Button>
          </>
        }
      >
        <form id="unit-form" className="form" onSubmit={submit} noValidate>
          {serverError && <Alert tone="danger" title="Não foi salvo">{serverError}</Alert>}
          <Field label="Nome da unidade" required error={errors.name}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: YouCon Poços de Caldas"
                aria-describedby={describedBy} aria-invalid={invalid} data-autofocus />
            )}
          </Field>
          {isNew && (
            <Field label="Identificador" error={errors.slug} hint="Usado em integrações (CRM). Não pode ser alterado depois.">
              {({ id, describedBy, invalid }) => (
                <Input id={id} value={slugTouched ? slug : slugify(name)}
                  onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
                  aria-describedby={describedBy} aria-invalid={invalid} />
              )}
            </Field>
          )}
          <LocationFields city={city} state={state} onChange={(v) => { setCity(v.city); setState(v.state); }} />
          {!isGlobal && (
            <Alert tone="info">Tipo, status e regras globais da unidade são definidos pela Franqueadora.</Alert>
          )}
        </form>
      </Drawer>

      <ConfirmDialog
        open={confirm}
        danger={unit?.status === "ativo"}
        loading={saving}
        title={unit?.status === "ativo" ? `Desativar ${unit?.name}?` : `Reativar ${unit?.name}?`}
        message={unit?.status === "ativo"
          ? "Todos os usuários desta unidade perdem o acesso imediatamente. Dados, projetos e histórico são preservados."
          : "Os usuários ativos desta unidade voltam a entrar normalmente."}
        confirmLabel={unit?.status === "ativo" ? "Desativar unidade" : "Reativar unidade"}
        onConfirm={toggleStatus}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

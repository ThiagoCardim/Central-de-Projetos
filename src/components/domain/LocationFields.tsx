import { useEffect, useMemo, useState } from "react";
import { Field, Select } from "@/components/ui/primitives";
import { OptionPicker } from "@/components/ui/OptionPicker";

/** Estados brasileiros (sigla e nome). */
export const UFS: { uf: string; name: string }[] = [
  ["AC", "Acre"], ["AL", "Alagoas"], ["AP", "Amapá"], ["AM", "Amazonas"], ["BA", "Bahia"], ["CE", "Ceará"],
  ["DF", "Distrito Federal"], ["ES", "Espírito Santo"], ["GO", "Goiás"], ["MA", "Maranhão"], ["MT", "Mato Grosso"],
  ["MS", "Mato Grosso do Sul"], ["MG", "Minas Gerais"], ["PA", "Pará"], ["PB", "Paraíba"], ["PR", "Paraná"],
  ["PE", "Pernambuco"], ["PI", "Piauí"], ["RJ", "Rio de Janeiro"], ["RN", "Rio Grande do Norte"], ["RS", "Rio Grande do Sul"],
  ["RO", "Rondônia"], ["RR", "Roraima"], ["SC", "Santa Catarina"], ["SP", "São Paulo"], ["SE", "Sergipe"], ["TO", "Tocantins"],
].map(([uf, name]) => ({ uf, name }));

type Cities = Record<string, { nome: string; cidades: string[] }>;
let citiesPromise: Promise<Cities> | null = null;
/** Municípios do IBGE (arquivo estático, carregado só quando precisa). */
function loadCities(): Promise<Cities> {
  if (!citiesPromise) {
    citiesPromise = fetch("/data/municipios.json", { cache: "force-cache" })
      .then((r) => { if (!r.ok) throw new Error("municipios"); return r.json() as Promise<Cities>; })
      .catch((e) => { citiesPromise = null; throw e; });
  }
  return citiesPromise;
}

export function useCities(uf: string): { cities: string[] | null; failed: boolean } {
  const [all, setAll] = useState<Cities | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!uf || all) return;
    let alive = true;
    loadCities().then((c) => alive && setAll(c)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [uf, all]);
  const cities = useMemo(() => (uf && all ? (all[uf]?.cidades ?? []).slice().sort((a, b) => a.localeCompare(b, "pt-BR")) : null), [uf, all]);
  return { cities, failed };
}

/**
 * UF + cidade, ambas escolhidas de listas (IBGE). Trocar a UF limpa a cidade.
 * Se a lista de cidades não carregar, a cidade continua selecionável pelo valor atual.
 */
export function LocationFields({ city, state, onChange, disabled, required }: {
  city: string; state: string; onChange: (v: { city: string; state: string }) => void; disabled?: boolean; required?: boolean;
}) {
  const { cities, failed } = useCities(state);
  const options = useMemo(() => {
    const list = cities ?? [];
    const withCurrent = city && !list.includes(city) ? [city, ...list] : list;
    return withCurrent.map((c) => ({ value: c, label: c }));
  }, [cities, city]);

  return (
    <div className="form__cols form__cols--city">
      <Field label="Cidade" required={required} hint={!state ? "Escolha a UF primeiro." : failed ? "Não foi possível carregar a lista de cidades." : undefined}>
        {({ id }) => (
          <OptionPicker id={id} label="Cidade" value={city} disabled={disabled || !state} loading={!!state && !cities && !failed}
            placeholder={state ? "Selecione a cidade" : "Escolha a UF"} searchPlaceholder="Buscar cidade" options={options}
            onChange={(v) => onChange({ city: v, state })} clearable
            emptyText="Nenhuma cidade nesta UF." />
        )}
      </Field>
      <Field label="UF" required={required}>
        {({ id }) => (
          <Select id={id} value={state} disabled={disabled} onChange={(e) => onChange({ state: e.target.value, city: e.target.value === state ? city : "" })}>
            <option value="">UF</option>
            {UFS.map((u) => <option key={u.uf} value={u.uf} title={u.name}>{u.uf}</option>)}
          </Select>
        )}
      </Field>
    </div>
  );
}

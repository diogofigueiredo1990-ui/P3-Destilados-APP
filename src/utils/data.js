/**
 * Utilitários de data com fuso horário de São Paulo (America/Sao_Paulo).
 *
 * PROBLEMA: `new Date().toISOString().slice(0, 10)` retorna a data em UTC.
 * Em São Paulo (UTC-3), às 23h00 local o UTC já é 02h00 do dia seguinte,
 * causando registros com data errada.
 *
 * SOLUÇÃO: usar sempre os getters locais (getFullYear / getMonth / getDate)
 * que respeitam o fuso do dispositivo — e garantir que o dispositivo/servidor
 * esteja configurado em America/Sao_Paulo.
 */

/**
 * Converte um objeto Date para string ISO no formato YYYY-MM-DD
 * usando a hora LOCAL do dispositivo (não UTC).
 */
export function dataParaISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Retorna a data de hoje como string YYYY-MM-DD no fuso local.
 * Substitui `new Date().toISOString().slice(0, 10)`.
 */
export function hojeISO() {
  return dataParaISO(new Date());
}

/** Total de dias úteis (seg–sex) no mês `mes` do ano `ano`. */
export function diasUteisNoMes(ano, mes) {
  let count = 0;
  const total = new Date(ano, mes, 0).getDate();
  for (let d = 1; d <= total; d++) {
    const dow = new Date(ano, mes - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/**
 * Dias úteis já passados no mês `mes`/`ano` até hoje.
 * Se for mês futuro ou passado, retorna o total do mês.
 */
export function diasUteisPassados(ano, mes) {
  const hoje = new Date();
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const limite = (ano === hoje.getFullYear() && mes === hoje.getMonth() + 1)
    ? hoje.getDate() : ultimoDia;
  let count = 0;
  for (let d = 1; d <= limite; d++) {
    const dow = new Date(ano, mes - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

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

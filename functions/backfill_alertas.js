/**
 * backfill_alertas.js — gera os alertas do DIA DE HOJE e salva em alertas_diarios
 *
 * Execute UMA ÚNICA VEZ (depois o Cloud Function cuida de cada madrugada):
 *   cd functions
 *   node backfill_alertas.js
 *
 * Autenticação: requer serviceAccountKey.json nesta mesma pasta.
 * Para baixar: Firebase Console → Configurações → Contas de serviço → Gerar nova chave privada
 */

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const keyPath = path.join(__dirname, 'serviceAccountKey.json');
try {
  initializeApp({ credential: cert(require(keyPath)) });
} catch (e) {
  console.error('\n❌ serviceAccountKey.json não encontrado em functions/');
  console.error('   Baixe em: Firebase Console → Configurações → Contas de serviço → Gerar nova chave privada\n');
  process.exit(1);
}

const db = getFirestore();

// ── Limiares (espelho de LinhaDoTempo.jsx) ────────────────────────────────────
const LIM = {
  prospecto: { amarelo: 15, vermelho: 23, expira: 30 },
  cliente:   { amarelo: 30, vermelho: 60, expira: 90 },
  pedido:    { amarelo: 30, vermelho: 60, expira: 90 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function dataISO(d) {
  const a = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dia = String(d.getDate()).padStart(2, '0');
  return `${a}-${m}-${dia}`;
}
function diasDesdeStr(str) {
  if (!str) return null;
  const d = new Date(String(str).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return null;
  const h = new Date(); h.setHours(0, 0, 0, 0);
  return Math.floor((h - d) / 86400000);
}
function nivelAlertaFn(dias, tipo) {
  const L = tipo === 'prospecto' ? LIM.prospecto : tipo === 'pedido' ? LIM.pedido : LIM.cliente;
  if (dias >= L.vermelho) return 'vermelho';
  if (dias >= L.amarelo)  return 'amarelo';
  return null;
}
function extrairEstado(n) { const m = String(n || '').match(/\s+([A-Z]{2})$/); return m ? m[1] : ''; }

// ── Lógica principal (idêntica ao Cloud Function) ─────────────────────────────
async function calcularParaDia(hoje) {
  console.log(`\n📥 Carregando coleções...`);

  const [snapVis, snapDes, snapPed, snapAg] = await Promise.all([
    db.collection('relatorioVisitas').get(),
    db.collection('desistencias').get(),
    db.collection('pedidosDia').get(),
    db.collection('agendamentosVisita').where('dataAgendada', '>=', hoje).get(),
  ]);

  console.log(`   ${snapVis.size} visitas | ${snapDes.size} desistências | ${snapPed.size} sugestões de pedido | ${snapAg.size} agendamentos`);

  const todasDesistencias = new Set(snapDes.docs.map(d => d.data().empresa).filter(Boolean));

  // última visita
  const ultimaVisitaPorEmpVend = {};
  snapVis.docs.forEach(d => {
    const r   = d.data();
    if (!r.empresa) return;
    const dt   = (r.dataHoraVisita || r.carimbo || '').slice(0, 10);
    if (!dt) return;
    const resp = r.vendedorResponsavel || r.vendedor || '';
    const est  = r.estado || extrairEstado(resp);
    const cnpj = r.cnpj || '';
    if (!resp) return;
    const key = `${resp}__${r.empresa}`;
    if (!ultimaVisitaPorEmpVend[key] || dt > ultimaVisitaPorEmpVend[key].lastDate)
      ultimaVisitaPorEmpVend[key] = { lastDate: dt, cnpj, estado: est };
  });

  // última compra
  const ultimaCompraPorCliVend = {};
  snapPed.docs.forEach(d => {
    const p = d.data();
    if (!p.cliente || !p.ultimaCompra) return;
    const resp = p.vendedorResponsavel || p.vendedor || '';
    const est  = p.estado || extrairEstado(resp);
    if (!resp) return;
    const key = `${resp}__${p.cliente}`;
    if (!ultimaCompraPorCliVend[key] ||
        diasDesdeStr(p.ultimaCompra) < diasDesdeStr(ultimaCompraPorCliVend[key].lastDate))
      ultimaCompraPorCliVend[key] = { lastDate: p.ultimaCompra, estado: est, cnpj: p.cnpj || '' };
  });

  // agendamentos futuros
  const agendMap = {};
  snapAg.docs.forEach(d => {
    const a = d.data();
    if (!a.empresa || !a.vendedor || !a.dataAgendada) return;
    const key = `${a.vendedor}__${a.empresa}`;
    if (!agendMap[key] || a.dataAgendada > agendMap[key]) agendMap[key] = a.dataAgendada;
  });

  const todosVendedores = new Set();
  Object.keys(ultimaVisitaPorEmpVend).forEach(k => todosVendedores.add(k.split('__')[0]));
  Object.keys(ultimaCompraPorCliVend).forEach(k => todosVendedores.add(k.split('__')[0]));

  console.log(`\n⚙️  Calculando alertas para ${todosVendedores.size} vendedores...`);

  let batch = db.batch(), countBatch = 0, countTotal = 0;

  for (const vendedor of todosVendedores) {
    if (!vendedor.trim()) continue;
    const mapaAlertas = {};

    // alertas de visita
    for (const [key, info] of Object.entries(ultimaVisitaPorEmpVend)) {
      const [vend, empresa] = key.split('__');
      if (vend !== vendedor) continue;
      if (todasDesistencias.has(empresa)) continue;
      const dias = diasDesdeStr(info.lastDate);
      if (dias === null) continue;
      const isCliente = !!info.cnpj;
      const tipoV = isCliente ? 'cliente' : 'prospecto';
      const L = isCliente ? LIM.cliente : LIM.prospecto;
      if (dias < L.amarelo || dias >= L.expira) continue;
      const nivelV = nivelAlertaFn(dias, tipoV);
      if (!nivelV) continue;
      if (!mapaAlertas[empresa]) {
        mapaAlertas[empresa] = { empresa, cnpj: info.cnpj, tipo: tipoV, estado: info.estado, nivelVisita: nivelV, nivelPedido: null, diasVisita: dias, diasPedido: null, lastDateVisita: info.lastDate, lastDatePedido: null };
      } else {
        Object.assign(mapaAlertas[empresa], { nivelVisita: nivelV, diasVisita: dias, lastDateVisita: info.lastDate });
      }
    }

    // alertas de pedido
    for (const [key, info] of Object.entries(ultimaCompraPorCliVend)) {
      const [vend, empresa] = key.split('__');
      if (vend !== vendedor) continue;
      if (todasDesistencias.has(empresa)) continue;
      const dias = diasDesdeStr(info.lastDate);
      if (dias === null || dias < LIM.pedido.amarelo || dias >= LIM.pedido.expira) continue;
      const nivelP = nivelAlertaFn(dias, 'pedido');
      if (!nivelP) continue;
      if (!mapaAlertas[empresa]) {
        mapaAlertas[empresa] = { empresa, cnpj: info.cnpj || '', tipo: 'cliente', estado: info.estado, nivelVisita: null, nivelPedido: nivelP, diasVisita: null, diasPedido: dias, lastDateVisita: null, lastDatePedido: info.lastDate };
      } else {
        Object.assign(mapaAlertas[empresa], { nivelPedido: nivelP, diasPedido: dias, lastDatePedido: info.lastDate });
        if (info.cnpj && !mapaAlertas[empresa].cnpj) mapaAlertas[empresa].cnpj = info.cnpj;
      }
    }

    const alertas = Object.values(mapaAlertas).map(a => {
      const nivelFinal = (a.nivelVisita === 'vermelho' || a.nivelPedido === 'vermelho') ? 'vermelho' : 'amarelo';
      const escuro = !!(a.nivelVisita && a.nivelPedido);
      const dias   = Math.max(a.diasVisita ?? 0, a.diasPedido ?? 0);
      let diasParaExpirar = null;
      if (a.diasVisita !== null) {
        const L = a.tipo === 'prospecto' ? LIM.prospecto : LIM.cliente;
        diasParaExpirar = L.expira - a.diasVisita;
      }
      if (a.diasPedido !== null) {
        const r = LIM.pedido.expira - a.diasPedido;
        if (diasParaExpirar === null || r < diasParaExpirar) diasParaExpirar = r;
      }
      const subTipo = a.nivelVisita && a.nivelPedido ? 'ambos' : a.nivelPedido ? 'pedido' : 'visita';
      return { empresa: a.empresa, cnpj: a.cnpj, tipo: a.tipo, estado: a.estado, nivel: nivelFinal, escuro, subTipo, nivelVisita: a.nivelVisita, nivelPedido: a.nivelPedido, diasVisita: a.diasVisita, diasPedido: a.diasPedido, dias, diasParaExpirar, lastDateVisita: a.lastDateVisita, lastDatePedido: a.lastDatePedido };
    }).sort((a, b) => a.nivel !== b.nivel ? (a.nivel === 'vermelho' ? -1 : 1) : b.dias - a.dias);

    // prospectos livres
    const prospectosLivres = [];
    for (const [key, info] of Object.entries(ultimaVisitaPorEmpVend)) {
      const [vend, empresa] = key.split('__');
      if (vend !== vendedor || info.cnpj) continue;
      if (todasDesistencias.has(empresa)) continue;
      const dias = diasDesdeStr(info.lastDate);
      if (dias !== null && dias >= LIM.prospecto.expira)
        prospectosLivres.push({ empresa, dias, lastDate: info.lastDate, estado: info.estado });
    }
    prospectosLivres.sort((a, b) => b.dias - a.dias);

    // clientes inativos
    const inativosMap = {};
    for (const [key, info] of Object.entries(ultimaVisitaPorEmpVend)) {
      const [vend, empresa] = key.split('__');
      if (vend !== vendedor || !info.cnpj) continue;
      if (todasDesistencias.has(empresa)) continue;
      const dias = diasDesdeStr(info.lastDate);
      if (dias !== null && dias >= LIM.cliente.expira)
        inativosMap[empresa] = { empresa, cnpj: info.cnpj, dias, lastDate: info.lastDate, estado: info.estado, motivo: 'visita' };
    }
    for (const [key, info] of Object.entries(ultimaCompraPorCliVend)) {
      const [vend, empresa] = key.split('__');
      if (vend !== vendedor) continue;
      if (todasDesistencias.has(empresa)) continue;
      const dias = diasDesdeStr(info.lastDate);
      if (dias !== null && dias >= LIM.pedido.expira && !inativosMap[empresa])
        inativosMap[empresa] = { empresa, cnpj: info.cnpj || '', dias, lastDate: info.lastDate, estado: info.estado, motivo: 'pedido' };
    }
    const clientesInativos = Object.values(inativosMap).sort((a, b) => b.dias - a.dias);

    const slug  = vendedor.toLowerCase().replace(/\s+/g, '_');
    const docId = `${slug}_${hoje}`;
    batch.set(db.collection('alertas_diarios').doc(docId), {
      vendedor, data: hoje, calculadoEm: Timestamp.now(),
      alertas, prospectosLivres, clientesInativos,
    }, { merge: true });

    countBatch++;
    countTotal++;
    if (countBatch >= 490) { await batch.commit(); process.stdout.write(`   ${countTotal} vendedores salvos...\r`); batch = db.batch(); countBatch = 0; }
  }

  if (countBatch > 0) await batch.commit();
  return countTotal;
}

async function main() {
  const hoje = dataISO(new Date());
  console.log(`\n🔄 Backfill de alertas_diarios para ${hoje}`);
  const n = await calcularParaDia(hoje);
  console.log(`\n✅ ${n} documentos gravados em alertas_diarios\n`);
}

main().catch(err => { console.error('\n❌ Erro:', err); process.exit(1); });

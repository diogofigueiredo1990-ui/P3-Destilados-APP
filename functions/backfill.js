/**
 * backfill.js — popula niveis_diarios com dados históricos (últimos 12 meses)
 *
 * Execute UMA ÚNICA VEZ:
 *   cd functions
 *   npm install          ← só na primeira vez
 *   node backfill.js
 *
 * Autenticação: coloque o arquivo serviceAccountKey.json nesta pasta.
 * Para baixar: Firebase Console → Configurações do projeto → Contas de serviço
 *              → Gerar nova chave privada
 */

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

// ── Autenticação ─────────────────────────────────────────────────────────────
const keyPath = path.join(__dirname, 'serviceAccountKey.json');
try {
  initializeApp({ credential: cert(require(keyPath)) });
} catch (e) {
  console.error('\n❌ Arquivo serviceAccountKey.json não encontrado em functions/');
  console.error('   Baixe em: Firebase Console → Configurações → Contas de serviço → Gerar nova chave privada\n');
  process.exit(1);
}

const db = getFirestore();

// ── Tabela de níveis (espelho de VendedorDashboard.jsx) ──────────────────────
const NIVEIS_COMERCIAIS = [
  { nivel: '1',  comissaoMinima: 0, inadimplenciaMax: 100, clientesAtivosMin: 10,  fatPorClienteMin: 0    },
  { nivel: '1+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 10,  fatPorClienteMin: 700  },
  { nivel: '2',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 25,  fatPorClienteMin: 700  },
  { nivel: '2+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 25,  fatPorClienteMin: 1200 },
  { nivel: '3',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 50,  fatPorClienteMin: 1200 },
  { nivel: '4',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 75,  fatPorClienteMin: 1200 },
  { nivel: '4+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 75,  fatPorClienteMin: 1700 },
  { nivel: '5',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 90,  fatPorClienteMin: 1700 },
  { nivel: '6',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 110, fatPorClienteMin: 1700 },
  { nivel: '6+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 110, fatPorClienteMin: 1900 },
  { nivel: '7',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 130, fatPorClienteMin: 1900 },
  { nivel: '7+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 130, fatPorClienteMin: 2200 },
  { nivel: '8',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 150, fatPorClienteMin: 2200 },
  { nivel: '8+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 150, fatPorClienteMin: 2700 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function dataISO(d) {
  const a = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dia = String(d.getDate()).padStart(2, '0');
  return `${a}-${m}-${dia}`;
}
function subDias(d, n) { const r = new Date(d); r.setDate(r.getDate() - n); return r; }
function normalizarVendedor(n) { return String(n || '').replace(/\s+[A-Z]{2}$/, '').trim(); }
function normalizarCnpj(c) {
  if (c == null) return null;
  return String(typeof c === 'number' ? Math.round(c) : c).replace(/\D/g, '') || null;
}
function extrairNumeroVenda(chave) {
  if (!chave) return null;
  const p = String(chave).split('_');
  return p.length >= 2 ? p[1] : null;
}
function finId(p) {
  const nv = extrairNumeroVenda(p.chave);
  return nv && p.contaAzul ? `${p.contaAzul}_${nv}` : null;
}
function calcularNivel(comPct, inadPct, clientes, fatCli) {
  const n = [...NIVEIS_COMERCIAIS].reverse().find(n =>
    comPct   >= n.comissaoMinima    &&
    inadPct  <= n.inadimplenciaMax  &&
    clientes >= n.clientesAtivosMin &&
    fatCli   >= n.fatPorClienteMin
  );
  return n?.nivel ?? null;
}

// ── Função principal ─────────────────────────────────────────────────────────
async function main() {
  const hoje    = new Date();
  // Calcula até 13 meses atrás para ter janelas de 30 dias cobrindo os últimos 12 meses
  const inicio13m = subDias(hoje, 13 * 30);

  console.log(`\n🔄 Backfill de niveis_diarios`);
  console.log(`   Período de pedidos carregado: ${dataISO(inicio13m)} → ${dataISO(hoje)}`);

  // 1. Carregar TODOS os pedidos do período em memória (1 query)
  console.log('\n📥 Carregando pedidos...');
  const pedSnap = await db.collection('pedidos')
    .where('dataVenda', '>=', dataISO(inicio13m))
    .where('dataVenda', '<=', dataISO(hoje))
    .get();
  const todosPedidos = pedSnap.docs.map(d => ({ ...d.data() }));
  console.log(`   ${todosPedidos.length} pedidos carregados`);

  // 2. Carregar TODOS os dados financeiros em memória (lotes de 30)
  console.log('📥 Carregando dados financeiros...');
  const allFinIds = [...new Set(todosPedidos.map(finId).filter(Boolean))];
  const finMap = {};
  for (let i = 0; i < allFinIds.length; i += 30) {
    const lote = allFinIds.slice(i, i + 30);
    const snap = await db.collection('financeiro').where('docId', 'in', lote).get();
    snap.docs.forEach(d => { const r = d.data(); finMap[r.docId] = r.statusGeral || 'EM_ABERTO'; });
    if (i % 300 === 0 && i > 0) process.stdout.write(`   ${i}/${allFinIds.length} finIds carregados\r`);
  }
  console.log(`   ${allFinIds.length} registros financeiros carregados`);

  // 3. Para cada dia dos últimos 12 meses, calcular nível por vendedor
  const inicio12m = subDias(hoje, 365);
  const diasTotal = Math.ceil((hoje - inicio12m) / 86400000) + 1;
  console.log(`\n⚙️  Calculando ${diasTotal} dias × vendedores...\n`);

  let batch       = db.batch();
  let countBatch  = 0;
  let countTotal  = 0;
  let countDias   = 0;

  // Itera dia a dia do mais antigo ao mais recente
  for (let d = new Date(inicio12m); d <= hoje; d.setDate(d.getDate() + 1)) {
    const dataHoje = dataISO(new Date(d));
    const data30   = dataISO(subDias(new Date(d), 30));

    // Filtra os pedidos na janela [d-30, d] em memória
    const pedJanela = todosPedidos.filter(p => {
      const dv = p.dataVenda || '';
      return dv >= data30 && dv <= dataHoje;
    });

    if (!pedJanela.length) { countDias++; continue; }

    // Agrupa por vendedor e por vendedorResponsavel
    const porVendedor  = {};
    const cnpjsPorResp = {};
    for (const p of pedJanela) {
      const v = String(p.vendedor || '').trim();
      if (v) { if (!porVendedor[v]) porVendedor[v] = []; porVendedor[v].push(p); }
      const vr   = String(p.vendedorResponsavel || '').trim();
      const cnpj = normalizarCnpj(p.cnpj) || p.cliente;
      if (vr && cnpj) {
        if (!cnpjsPorResp[vr]) cnpjsPorResp[vr] = new Set();
        cnpjsPorResp[vr].add(cnpj);
      }
    }

    for (const [vendedor, peds] of Object.entries(porVendedor)) {
      const totalFat       = peds.reduce((s, p) => s + Number(p.faturamento || 0), 0);
      const totalCom       = peds.reduce((s, p) => s + Number(p.comissao    || 0), 0);
      const clientesAtivos = cnpjsPorResp[vendedor]?.size ?? 0;
      const fatPorCliente  = clientesAtivos > 0 ? totalFat / clientesAtivos : 0;
      const fatBloq        = peds.filter(p => finMap[finId(p)] === 'ATRASADO').reduce((s, p) => s + Number(p.faturamento || 0), 0);
      const comissaoPercent       = totalFat > 0 ? (totalCom / totalFat) * 100 : 0;
      const inadimplenciaPercent  = totalFat > 0 ? (fatBloq  / totalFat) * 100 : 0;
      const nivel          = calcularNivel(comissaoPercent, inadimplenciaPercent, clientesAtivos, fatPorCliente);
      const vendedorNorm   = normalizarVendedor(vendedor);
      const docId          = `${vendedor.toLowerCase().replace(/\s+/g, '_')}_${dataHoje}`;

      batch.set(db.collection('niveis_diarios').doc(docId), {
        vendedor, vendedorNorm, data: dataHoje,
        totalFat, totalCom, comissaoPercent, clientesAtivos, fatPorCliente,
        inadimplenciaPercent, nivel, calculadoEm: Timestamp.now(),
      }, { merge: true });

      countBatch++;
      countTotal++;

      if (countBatch >= 490) {
        await batch.commit();
        process.stdout.write(`   ✅ ${countTotal} docs gravados (dia ${dataHoje})...\r`);
        batch = db.batch();
        countBatch = 0;
      }
    }

    countDias++;
    if (countDias % 30 === 0) {
      process.stdout.write(`   📅 ${countDias}/${diasTotal} dias processados...\r`);
    }
  }

  // Comita o lote restante
  if (countBatch > 0) await batch.commit();

  console.log(`\n\n✅ Backfill concluído!`);
  console.log(`   ${diasTotal} dias processados`);
  console.log(`   ${countTotal} documentos gravados em niveis_diarios\n`);
}

main().catch(err => { console.error('\n❌ Erro fatal:', err); process.exit(1); });

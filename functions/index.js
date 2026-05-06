/**
 * calcularNiveisDiarios
 * Roda toda madrugada (02:00 BRT) e grava um documento em
 * niveis_diarios/{vendedor}_{data} com as métricas de cada vendedor
 * calculadas sobre os últimos 30 dias corridos.
 *
 * Estrutura do documento gerado:
 *   vendedor            : string  — nome original (ex: "Diogo MG")
 *   vendedorNorm        : string  — sem sufixo de estado (ex: "Diogo")
 *   data                : string  — "YYYY-MM-DD" (dia do cálculo)
 *   totalFat            : number  — faturamento total (R$)
 *   totalCom            : number  — comissão total (R$)
 *   comissaoPercent     : number  — % de comissão sobre fat
 *   clientesAtivos      : number  — CNPJs únicos via vendedorResponsavel
 *   fatPorCliente       : number  — faturamento / clientesAtivos
 *   inadimplenciaPercent: number  — % do fat com status ATRASADO
 *   nivel               : string  — nível comercial (ex: "2+") ou null
 *   calculadoEm         : Timestamp
 */

const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { initializeApp }  = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

initializeApp();
const db = getFirestore();

// ── Tabela de níveis (espelho de VendedorDashboard.jsx) ─────────────────────
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
  // Garante formato YYYY-MM-DD no fuso horário local do servidor
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function subDias(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() - n);
  return r;
}

function normalizarVendedor(nome) {
  return String(nome || '').replace(/\s+[A-Z]{2}$/, '').trim();
}

function normalizarCnpj(cnpj) {
  if (cnpj == null) return null;
  return String(typeof cnpj === 'number' ? Math.round(cnpj) : cnpj).replace(/\D/g, '') || null;
}

function extrairNumeroVenda(chave) {
  if (!chave) return null;
  const partes = String(chave).split('_');
  return partes.length >= 2 ? partes[1] : null;
}

function finId(p) {
  const nv = extrairNumeroVenda(p.chave);
  return nv && p.contaAzul ? `${p.contaAzul}_${nv}` : null;
}

function calcularNivel(comPct, inadPct, clientes, fatCli) {
  // Percorre do nível mais alto para o mais baixo e retorna o primeiro que o vendedor atinge
  const n = [...NIVEIS_COMERCIAIS].reverse().find(n =>
    comPct   >= n.comissaoMinima   &&
    inadPct  <= n.inadimplenciaMax &&
    clientes >= n.clientesAtivosMin &&
    fatCli   >= n.fatPorClienteMin
  );
  return n?.nivel ?? null;
}

// Busca a coleção financeiro em lotes de 30 (limite do Firestore para 'in')
async function buscarStatusFinanceiro(pedidos) {
  const ids = [...new Set(pedidos.map(finId).filter(Boolean))];
  if (!ids.length) return {};
  const finMap = {};
  for (let i = 0; i < ids.length; i += 30) {
    const lote = ids.slice(i, i + 30);
    const snap = await db.collection('financeiro').where('docId', 'in', lote).get();
    snap.docs.forEach(d => {
      const data = d.data();
      finMap[data.docId] = data.statusGeral || 'EM_ABERTO';
    });
  }
  return finMap;
}

// ── Função principal ─────────────────────────────────────────────────────────

exports.calcularNiveisDiarios = onSchedule(
  {
    schedule:  '0 2 * * *',          // 02:00 todos os dias
    timeZone:  'America/Sao_Paulo',
    region:    'southamerica-east1', // servidor em São Paulo → menor latência ao Firestore
    memory:    '256MiB',
    timeoutSeconds: 300,
  },
  async (_event) => {
    const hoje   = new Date();
    const hoje30 = subDias(hoje, 30);

    const dataHoje = dataISO(hoje);
    const data30   = dataISO(hoje30);

    logger.info(`▶ Iniciando cálculo de níveis — janela: ${data30} → ${dataHoje}`);

    // 1. Todos os pedidos dos últimos 30 dias (uma única query)
    const pedSnap = await db.collection('pedidos')
      .where('dataVenda', '>=', data30)
      .where('dataVenda', '<=', dataHoje)
      .get();

    const pedidos = pedSnap.docs.map(d => ({ ...d.data() }));
    logger.info(`   ${pedidos.length} pedidos encontrados`);

    if (!pedidos.length) {
      logger.warn('Nenhum pedido no período — abortando.');
      return;
    }

    // 2. Agrupar por vendedor (comissão) e por vendedorResponsavel (clientes ativos)
    const porVendedor  = {};   // vendedor → [pedido, ...]
    const cnpjsPorResp = {};   // vendedorResponsavel → Set<cnpj>

    for (const p of pedidos) {
      const v = String(p.vendedor || '').trim();
      if (v) {
        if (!porVendedor[v]) porVendedor[v] = [];
        porVendedor[v].push(p);
      }
      const vr   = String(p.vendedorResponsavel || '').trim();
      const cnpj = normalizarCnpj(p.cnpj) || p.cliente;
      if (vr && cnpj) {
        if (!cnpjsPorResp[vr]) cnpjsPorResp[vr] = new Set();
        cnpjsPorResp[vr].add(cnpj);
      }
    }

    // 3. Buscar status financeiro de todos os pedidos de uma vez
    const finMap = await buscarStatusFinanceiro(pedidos);

    // 4. Calcular métricas e salvar (Firestore Batch, máx 500 writes)
    let batch = db.batch();
    let countBatch = 0;
    let countTotal = 0;

    for (const [vendedor, peds] of Object.entries(porVendedor)) {
      const totalFat = peds.reduce((s, p) => s + Number(p.faturamento || 0), 0);
      const totalCom = peds.reduce((s, p) => s + Number(p.comissao    || 0), 0);

      const clientesAtivos = cnpjsPorResp[vendedor]?.size ?? 0;
      const fatPorCliente  = clientesAtivos > 0 ? totalFat / clientesAtivos : 0;

      const fatBloq = peds
        .filter(p => finMap[finId(p)] === 'ATRASADO')
        .reduce((s, p) => s + Number(p.faturamento || 0), 0);

      const comissaoPercent      = totalFat > 0 ? (totalCom / totalFat) * 100 : 0;
      const inadimplenciaPercent = totalFat > 0 ? (fatBloq  / totalFat) * 100 : 0;

      const nivel        = calcularNivel(comissaoPercent, inadimplenciaPercent, clientesAtivos, fatPorCliente);
      const vendedorNorm = normalizarVendedor(vendedor);

      // ID do documento: "diogo_mg_2025-05-06"
      const docId = `${vendedor.toLowerCase().replace(/\s+/g, '_')}_${dataHoje}`;

      const ref = db.collection('niveis_diarios').doc(docId);
      batch.set(ref, {
        vendedor,
        vendedorNorm,
        data:                 dataHoje,
        totalFat,
        totalCom,
        comissaoPercent,
        clientesAtivos,
        fatPorCliente,
        inadimplenciaPercent,
        nivel,
        calculadoEm:          Timestamp.now(),
      });

      countBatch++;
      countTotal++;

      // Comita o lote ao atingir 490 (margem de segurança antes do limite 500)
      if (countBatch >= 490) {
        await batch.commit();
        logger.info(`   Lote parcial: ${countTotal} vendedores salvos`);
        batch = db.batch();
        countBatch = 0;
      }
    }

    // Comita o que sobrou
    if (countBatch > 0) await batch.commit();

    logger.info(`✅ Concluído — ${countTotal} documentos gravados em niveis_diarios`);
  }
);

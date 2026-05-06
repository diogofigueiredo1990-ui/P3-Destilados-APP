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

// ════════════════════════════════════════════════════════════════════════════
//  calcularAlertasDiarios
//  Roda às 02:30 BRT e grava alertas_diarios/{vendedor}_{data} com:
//    · alertas[]       — cards de alerta (amarelo/vermelho) por empresa
//    · prospectosLivres[] — prospectos expirados (≥30d sem visita)
//    · clientesInativos[] — clientes inativos (≥90d sem visita ou pedido)
//
//  Cada alerta:
//    empresa, cnpj, tipo (cliente|prospecto), estado
//    nivel (vermelho|amarelo)   — o mais grave entre visita e pedido
//    escuro (bool)              — true quando TEM AMBOS visita + pedido
//    nivelVisita, nivelPedido   — nível individual de cada tipo
//    diasVisita, diasPedido     — dias sem cada atividade (null se n/a)
//    dias                       — max(diasVisita, diasPedido) — para exibição
//    diasParaExpirar            — dias até sair do radar
//    lastDateVisita, lastDatePedido
// ════════════════════════════════════════════════════════════════════════════

const LIM = {
  prospecto: { amarelo: 15, vermelho: 23, expira: 30 },
  cliente:   { amarelo: 30, vermelho: 60, expira: 90 },
  pedido:    { amarelo: 30, vermelho: 60, expira: 90 },
};

function diasDesdeStr(str) {
  if (!str) return null;
  const d = new Date(String(str).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje - d) / 86400000);
}

function nivelAlertaFn(dias, tipo) {
  const L = tipo === 'prospecto' ? LIM.prospecto : tipo === 'pedido' ? LIM.pedido : LIM.cliente;
  if (dias >= L.vermelho) return 'vermelho';
  if (dias >= L.amarelo)  return 'amarelo';
  return null;
}

function extrairEstadoNome(nome) {
  const m = String(nome || '').match(/\s+([A-Z]{2})$/);
  return m ? m[1] : '';
}

exports.calcularAlertasDiarios = onSchedule(
  {
    schedule:      '30 2 * * *',
    timeZone:      'America/Sao_Paulo',
    region:        'southamerica-east1',
    memory:        '512MiB',
    timeoutSeconds: 540,
  },
  async (_event) => {
    const hoje = dataISO(new Date());
    logger.info(`▶ calcularAlertasDiarios — ${hoje}`);

    // 1. Carrega as 4 coleções em paralelo
    const [snapVis, snapDes, snapPed, snapAg] = await Promise.all([
      db.collection('relatorioVisitas').get(),
      db.collection('desistencias').get(),
      db.collection('pedidosDia').get(),
      db.collection('agendamentosVisita').where('dataAgendada', '>=', hoje).get(),
    ]);

    // 2. Desistências (global — qualquer vendedor)
    const todasDesistencias = new Set(
      snapDes.docs.map(d => d.data().empresa).filter(Boolean)
    );

    // 3. Última visita por empresa (responsável → {lastDate, cnpj, estado})
    const ultimaVisitaPorEmpVend = {}; // `${vendedor}__${empresa}` → {lastDate, cnpj, estado}
    const ultimaVisitaGlobal     = {}; // empresa → {lastDate, cnpj, vendedor, estado}

    snapVis.docs.forEach(d => {
      const r   = d.data();
      if (!r.empresa) return;
      const dt   = (r.dataHoraVisita || r.carimbo || '').slice(0, 10);
      if (!dt) return;
      const resp = r.vendedorResponsavel || r.vendedor || '';
      const est  = r.estado || extrairEstadoNome(resp);
      const cnpj = r.cnpj || '';

      // global (para prospectos livres / inativos globais)
      if (!ultimaVisitaGlobal[r.empresa] || dt > ultimaVisitaGlobal[r.empresa].lastDate)
        ultimaVisitaGlobal[r.empresa] = { lastDate: dt, cnpj, vendedor: resp, estado: est };

      // por vendedor responsável
      if (!resp) return;
      const key = `${resp}__${r.empresa}`;
      if (!ultimaVisitaPorEmpVend[key] || dt > ultimaVisitaPorEmpVend[key].lastDate)
        ultimaVisitaPorEmpVend[key] = { lastDate: dt, cnpj, estado: est };
    });

    // 4. Última compra por cliente × vendedor responsável (via pedidosDia)
    const ultimaCompraPorCliVend = {}; // `${vendedor}__${cliente}` → {lastDate, estado, cnpj}
    const ultimaCompraGlobal     = {}; // cliente → {lastDate, vendedor, estado}

    snapPed.docs.forEach(d => {
      const p = d.data();
      if (!p.cliente || !p.ultimaCompra) return;
      const resp = p.vendedorResponsavel || p.vendedor || '';
      const est  = p.estado || extrairEstadoNome(resp);
      const dt   = p.ultimaCompra;

      // global
      if (!ultimaCompraGlobal[p.cliente] ||
          diasDesdeStr(dt) < diasDesdeStr(ultimaCompraGlobal[p.cliente].lastDate))
        ultimaCompraGlobal[p.cliente] = { lastDate: dt, vendedor: resp, estado: est };

      if (!resp) return;
      const key = `${resp}__${p.cliente}`;
      if (!ultimaCompraPorCliVend[key] ||
          diasDesdeStr(dt) < diasDesdeStr(ultimaCompraPorCliVend[key].lastDate))
        ultimaCompraPorCliVend[key] = { lastDate: dt, estado: est, cnpj: p.cnpj || '' };
    });

    // 5. Agendamentos futuros (para excluir das listas, igual ao front-end)
    const agendMap = {}; // `${vendedor}__${empresa}` → dataAgendada
    snapAg.docs.forEach(d => {
      const a = d.data();
      if (!a.empresa || !a.vendedor || !a.dataAgendada) return;
      const key = `${a.vendedor}__${a.empresa}`;
      if (!agendMap[key] || a.dataAgendada > agendMap[key]) agendMap[key] = a.dataAgendada;
    });

    // 6. Descobre todos os vendedores que aparecem
    const todosVendedores = new Set();
    Object.keys(ultimaVisitaPorEmpVend).forEach(k => todosVendedores.add(k.split('__')[0]));
    Object.keys(ultimaCompraPorCliVend).forEach(k => todosVendedores.add(k.split('__')[0]));

    // 7. Calcula alertas por vendedor e salva
    let batch = db.batch();
    let countBatch = 0, countTotal = 0;

    for (const vendedor of todosVendedores) {
      if (!vendedor.trim()) continue;

      const mapaAlertas = {}; // empresa → alerta parcial

      // ── Alertas de VISITA ─────────────────────────────────────────────
      for (const [key, info] of Object.entries(ultimaVisitaPorEmpVend)) {
        const [vend, empresa] = key.split('__');
        if (vend !== vendedor) continue;
        if (todasDesistencias.has(empresa)) continue;

        const dias = diasDesdeStr(info.lastDate);
        if (dias === null) continue;

        const isCliente = !!info.cnpj;
        const tipoVisita = isCliente ? 'cliente' : 'prospecto';
        const L = isCliente ? LIM.cliente : LIM.prospecto;

        if (dias < L.amarelo || dias >= L.expira) continue; // fora do range de alerta

        const nivelV = nivelAlertaFn(dias, tipoVisita);
        if (!nivelV) continue;

        if (!mapaAlertas[empresa]) {
          mapaAlertas[empresa] = {
            empresa, cnpj: info.cnpj, tipo: tipoVisita, estado: info.estado,
            nivelVisita: nivelV, nivelPedido: null,
            diasVisita: dias, diasPedido: null,
            lastDateVisita: info.lastDate, lastDatePedido: null,
          };
        } else {
          mapaAlertas[empresa].nivelVisita  = nivelV;
          mapaAlertas[empresa].diasVisita   = dias;
          mapaAlertas[empresa].lastDateVisita = info.lastDate;
        }
      }

      // ── Alertas de PEDIDO ─────────────────────────────────────────────
      for (const [key, info] of Object.entries(ultimaCompraPorCliVend)) {
        const [vend, empresa] = key.split('__');
        if (vend !== vendedor) continue;
        if (todasDesistencias.has(empresa)) continue;

        const dias = diasDesdeStr(info.lastDate);
        if (dias === null) continue;
        if (dias < LIM.pedido.amarelo || dias >= LIM.pedido.expira) continue;

        const nivelP = nivelAlertaFn(dias, 'pedido');
        if (!nivelP) continue;

        if (!mapaAlertas[empresa]) {
          mapaAlertas[empresa] = {
            empresa, cnpj: info.cnpj || '', tipo: 'cliente', estado: info.estado,
            nivelVisita: null, nivelPedido: nivelP,
            diasVisita: null, diasPedido: dias,
            lastDateVisita: null, lastDatePedido: info.lastDate,
          };
        } else {
          mapaAlertas[empresa].nivelPedido   = nivelP;
          mapaAlertas[empresa].diasPedido    = dias;
          mapaAlertas[empresa].lastDatePedido = info.lastDate;
          if (info.cnpj && !mapaAlertas[empresa].cnpj) mapaAlertas[empresa].cnpj = info.cnpj;
        }
      }

      // ── Consolida: nivel final, escuro, dias, diasParaExpirar ──────────
      const alertas = Object.values(mapaAlertas).map(a => {
        const nivelFinal = (a.nivelVisita === 'vermelho' || a.nivelPedido === 'vermelho')
          ? 'vermelho' : 'amarelo';
        const escuro = !!(a.nivelVisita && a.nivelPedido);
        const dias   = Math.max(a.diasVisita ?? 0, a.diasPedido ?? 0);

        // diasParaExpirar: dias até sair do radar (usa o MENOR limite dos tipos presentes)
        let diasParaExpirar = null;
        if (a.diasVisita !== null) {
          const L = a.tipo === 'prospecto' ? LIM.prospecto : LIM.cliente;
          diasParaExpirar = L.expira - a.diasVisita;
        }
        if (a.diasPedido !== null) {
          const restP = LIM.pedido.expira - a.diasPedido;
          if (diasParaExpirar === null || restP < diasParaExpirar) diasParaExpirar = restP;
        }

        // subTipo para compatibilidade com o front-end
        const subTipo = a.nivelVisita && a.nivelPedido ? 'ambos'
          : a.nivelPedido ? 'pedido' : 'visita';

        return {
          empresa: a.empresa, cnpj: a.cnpj, tipo: a.tipo, estado: a.estado,
          nivel: nivelFinal, escuro, subTipo,
          nivelVisita: a.nivelVisita, nivelPedido: a.nivelPedido,
          diasVisita: a.diasVisita, diasPedido: a.diasPedido,
          dias, diasParaExpirar,
          lastDateVisita: a.lastDateVisita, lastDatePedido: a.lastDatePedido,
        };
      }).sort((a, b) => {
        if (a.nivel !== b.nivel) return a.nivel === 'vermelho' ? -1 : 1;
        return b.dias - a.dias;
      });

      // ── Prospectos Livres (≥ expira de visita) ─────────────────────────
      const prospectosLivres = [];
      for (const [key, info] of Object.entries(ultimaVisitaPorEmpVend)) {
        const [vend, empresa] = key.split('__');
        if (vend !== vendedor || info.cnpj) continue;   // só prospectos
        if (todasDesistencias.has(empresa)) continue;
        const dias = diasDesdeStr(info.lastDate);
        if (dias !== null && dias >= LIM.prospecto.expira)
          prospectosLivres.push({ empresa, dias, lastDate: info.lastDate, estado: info.estado });
      }
      prospectosLivres.sort((a, b) => b.dias - a.dias);

      // ── Clientes Inativos (visita ≥90d ou pedido ≥90d) ────────────────
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

      // ── Grava no Firestore ─────────────────────────────────────────────
      const slug  = vendedor.toLowerCase().replace(/\s+/g, '_');
      const docId = `${slug}_${hoje}`;
      batch.set(db.collection('alertas_diarios').doc(docId), {
        vendedor, data: hoje, calculadoEm: Timestamp.now(),
        alertas, prospectosLivres, clientesInativos,
      });

      countBatch++;
      countTotal++;

      if (countBatch >= 490) {
        await batch.commit();
        batch = db.batch();
        countBatch = 0;
      }
    }

    if (countBatch > 0) await batch.commit();
    logger.info(`✅ calcularAlertasDiarios — ${countTotal} vendedores em alertas_diarios`);
  }
);

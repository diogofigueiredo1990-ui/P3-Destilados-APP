import { useState, useEffect, useMemo } from 'react';
import { collection, query, where, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { hojeISO, dataParaISO } from '../utils/data';
import { db } from '../firebase/config';

const FORM_VISITA_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScV0qcBHN3VXHTyxSLWgV6yPGW-2o_ZY5cr_DkSVnXgjZxlwQ/viewform';

// Limiares de alerta (dias)
const LIMITE = {
  prospecto: { amarelo: 14, vermelho: 23, expira: 30 },
  cliente:   { amarelo: 30, vermelho: 60, expira: 90 },
  pedido:    { amarelo: 30, vermelho: 60, expira: 90 },
};

// ── helpers de data / alertas ────────────────────────────

function diasDesde(str) {
  if (!str) return null;
  const d = new Date(String(str).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje - d) / 86400000);
}

function maxDataAgend(lastDateStr, tipo, nivel) {
  const d = new Date(String(lastDateStr).slice(0, 10) + 'T00:00:00');
  if (tipo === 'prospecto')
    d.setDate(d.getDate() + (nivel === 'amarelo' ? LIMITE.prospecto.vermelho - 1 : LIMITE.prospecto.expira - 1));
  else
    d.setDate(d.getDate() + (nivel === 'amarelo' ? LIMITE.cliente.vermelho - 1 : LIMITE.cliente.expira - 1));
  return dataParaISO(d);
}

function nivelAlerta(dias, tipo) {
  const L = tipo === 'prospecto' ? LIMITE.prospecto : tipo === 'pedido' ? LIMITE.pedido : LIMITE.cliente;
  if (dias >= (L.vermelho)) return 'vermelho';
  if (dias >= (L.amarelo))  return 'amarelo';
  return null;
}

function extrairEstado(nomeVendedor) {
  const m = String(nomeVendedor || '').match(/\s+([A-Z]{2})$/);
  return m ? m[1] : '';
}

function agruparPorEstado(lista) {
  const mapa = {};
  lista.forEach((item) => {
    const e = item.estado || '—';
    if (!mapa[e]) mapa[e] = [];
    mapa[e].push(item);
  });
  // estados conhecidos (2 letras) primeiro, ordenados; "—" por último
  return Object.entries(mapa).sort((a, b) => {
    if (a[0] === '—') return 1;
    if (b[0] === '—') return -1;
    return a[0].localeCompare(b[0]);
  });
}

function formatarDataAgenda(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ── helpers ──────────────────────────────────────────────

function resolverTipo(tipo) {
  const t = String(tipo || '').toLowerCase();
  if (t.includes('visita'))  return { label: 'Visita',             icon: '🤝', cor: '#16a34a', bg: '#dcfce7' };
  if (t.includes('prospec')) return { label: 'Prospecção',         icon: '🔍', cor: '#7c3aed', bg: '#ede9fe' };
  if (t.includes('liga'))    return { label: 'Ligação',            icon: '📞', cor: '#d97706', bg: '#fef3c7' };
  if (t.includes('follow'))  return { label: 'Follow-up',         icon: '📋', cor: '#0f3460', bg: '#e0e7ff' };
  return                            { label: 'Sugestão de Pedido', icon: '🛒', cor: '#2563eb', bg: '#dbeafe' };
}

// Produto parou de usar: tendência indica isso OU não tem qtd sugerida
function parouDeUsar(p) {
  const t = String(p.tendencia || '').toLowerCase();
  if (t.includes('parou')) return true;
  const qtd = parseFloat(p.qtdSugerida);
  return isNaN(qtd) || qtd <= 0;
}

function seta(tendencia) {
  const t = String(tendencia || '').toLowerCase();
  if (t.includes('cresc') || t.includes('alta') || t.includes('subindo'))
    return { icon: '↑', cor: '#16a34a' };
  if (t.includes('parou') || t.includes('queda') || t.includes('cai'))
    return { icon: '↓', cor: '#dc2626' };
  return { icon: '→', cor: '#d97706' };
}

function tendenciaGlobal(ativos) {
  if (!ativos.length) return { icon: '→', cor: '#9ca3af' };
  let up = 0, down = 0, side = 0;
  for (const p of ativos) {
    const s = seta(p.tendencia);
    if (s.icon === '↑') up++;
    else if (s.icon === '↓') down++;
    else side++;
  }
  if (up >= down && up >= side) return { icon: '↑', cor: '#16a34a' };
  if (down > up && down >= side) return { icon: '↓', cor: '#dc2626' };
  return { icon: '→', cor: '#d97706' };
}

function formatarData(val) {
  if (!val) return null;
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}/))
    return val.slice(0, 10).split('-').reverse().join('/');
  return null;
}

function corEstoque(val) {
  const v = String(val || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!v || v === '-') return null;
  if (v.includes('ok') || v.includes('normal') || v.includes('disp'))
    return { cor: '#16a34a', bg: '#dcfce7' };
  if (v.includes('baixo') || v.includes('reduz') || v.includes('limit'))
    return { cor: '#d97706', bg: '#fef3c7' };
  if (v.includes('crit') || v.includes('ruptura') || v.includes('zerado') || v.includes('esgot'))
    return { cor: '#dc2626', bg: '#fee2e2' };
  return { cor: '#6b7280', bg: '#f3f4f6' };
}

function saudacao() {
  const h = new Date().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function dataHoje() {
  return new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function agruparPorCliente(itens) {
  const mapa = {};
  for (const item of itens) {
    const key = item.cliente || '(sem cliente)';
    if (!mapa[key]) mapa[key] = { cliente: key, tipo: item.tipo, produtos: [] };
    mapa[key].produtos.push(item);
  }
  return Object.values(mapa);
}

// ── componente principal ──────────────────────────────────

function normalizarNome(n) {
  return String(n || '').replace(/\s+[A-Z]{2}$/, '').trim();
}

export default function LinhaDoTempo({ vendedorNome }) {
  const [itens, setItens]           = useState([]);
  const [contatos, setContatos]     = useState({});
  const [feitos, setFeitos]         = useState(new Set());
  const [expandidos, setExpandidos] = useState(new Set());
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro]             = useState(null);
  const [pedidosHoje, setPedidosHoje] = useState([]);

  // alertas
  const [visitasMap, setVisitasMap]         = useState({});  // { empresa: { lastDate, cnpj } }
  const [desistidas, setDesistidas]         = useState(new Set());
  const [agendamentosMap, setAgendamentosMap] = useState({}); // { empresa: 'YYYY-MM-DD' }
  const [modalAgendar, setModalAgendar]     = useState(null);
  const [modalDesistir, setModalDesistir]   = useState(null);
  const [dataAgend, setDataAgend]           = useState('');
  const [salvandoAcao, setSalvandoAcao]     = useState(false);
  const [prospectosLivres, setProspectosLivres] = useState([]);
  const [clientesInativos, setClientesInativos] = useState([]);
  const [mostrarPL, setMostrarPL]           = useState(false);
  const [mostrarCI, setMostrarCI]           = useState(false);
  const [alertasFeitos, setAlertasFeitos]   = useState(new Set());
  const [aba, setAba]                       = useState('hoje'); // 'hoje' | 'agenda'
  const [agendamentosList, setAgendamentosList] = useState([]); // lista completa p/ Agenda

  useEffect(() => {
    if (!vendedorNome) { setCarregando(false); return; }
    setCarregando(true);
    setErro(null);

    getDocs(query(collection(db, 'pedidosDia'), where('vendedor', '==', vendedorNome)))
      .then(async (snap) => {
        const hoje = hojeISO();
        const lista = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((d) => d.dataSugestao === hoje);
        setItens(lista);

        // Busca nomes de contato na coleção clientes
        const nomes = [...new Set(lista.map((i) => i.cliente).filter(Boolean))];
        const mapa  = {};
        for (let i = 0; i < nomes.length; i += 30) {
          const lote = nomes.slice(i, i + 30);
          const q = query(collection(db, 'clientes'), where('cliente', 'in', lote));
          const s = await getDocs(q);
          s.docs.forEach((d) => {
            const data = d.data();
            if (data.cliente && data.contato)
              mapa[data.cliente] = data.contato;
          });
        }
        setContatos(mapa);
      })
      .catch((e) => { console.error(e); setErro('Erro ao carregar atividades.'); })
      .finally(() => setCarregando(false));
  }, [vendedorNome]);

  // ── busca pedidos reais do dia (coleção "pedidos") ───────
  useEffect(() => {
    if (!vendedorNome) return;
    const hoje = hojeISO();
    const nomeNorm = normalizarNome(vendedorNome);

    getDocs(query(
      collection(db, 'pedidos'),
      where('dataVenda', '>=', hoje),
      where('dataVenda', '<=', hoje),
    )).then((snap) => {
      const lista = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((p) => {
          const v = String(p.vendedor || '');
          return v === vendedorNome || normalizarNome(v) === nomeNorm;
        });

      // Agrupa por venda (chave = contaAzul_numeroVenda)
      const mapaVendas = {};
      for (const p of lista) {
        const partes = (p.chave || '').split('_');
        const vidKey = partes.length >= 2 ? `${p.contaAzul || ''}_${partes[1]}` : (p.chave || p.id);
        if (!mapaVendas[vidKey]) {
          mapaVendas[vidKey] = {
            key: vidKey,
            cliente: p.cliente || '—',
            numeroVenda: partes[1] || p.chave || '',
            situacao: p.situacao || '',
            estado: p.estado || '',
            produtos: [],
            totalFat: 0,
            totalCom: 0,
          };
        }
        mapaVendas[vidKey].produtos.push(p);
        mapaVendas[vidKey].totalFat += Number(p.faturamento || 0);
        mapaVendas[vidKey].totalCom += Number(p.comissao || 0);
      }
      setPedidosHoje(Object.values(mapaVendas).sort((a, b) => b.totalFat - a.totalFat));
    }).catch((e) => console.error('pedidosHoje:', e));
  }, [vendedorNome]);

  // ── busca dados para alertas de visita ───────────────────
  useEffect(() => {
    if (!vendedorNome) return;

    async function carregarAlertas() {
      try {
        const hoje = hojeISO();

        // 1. Visitas — lê TUDO (alimenta mapa do vendedor + listas globais)
        const snapVis = await getDocs(collection(db, 'relatorioVisitas'));
        const mapaVendedor = {};
        const mapaGlobal   = {};
        snapVis.docs.forEach((d) => {
          const r = d.data();
          if (!r.empresa) return;
          const dt   = (r.dataHoraVisita || r.carimbo || '').slice(0, 10);
          const est  = r.estado || extrairEstado(r.vendedor);
          const resp = r.vendedorResponsavel || r.vendedor || ''; // responsável atual, fallback para quem visitou

          if (!mapaGlobal[r.empresa] || dt > mapaGlobal[r.empresa].lastDate)
            mapaGlobal[r.empresa] = { lastDate: dt, cnpj: r.cnpj || '', vendedor: resp, estado: est };

          // Alimenta mapaVendedor pelo responsável atual (não por quem visitou)
          if (resp === vendedorNome) {
            if (!mapaVendedor[r.empresa] || dt > mapaVendedor[r.empresa].lastDate)
              mapaVendedor[r.empresa] = { lastDate: dt, cnpj: r.cnpj || '' };
          }
        });
        setVisitasMap(mapaVendedor);

        // 2. Desistências — lê TUDO (filtra vendedor p/ estado local + global p/ listas)
        const snapDes = await getDocs(collection(db, 'desistencias'));
        const todasDesistencias = new Set(snapDes.docs.map((d) => d.data().empresa));
        setDesistidas(new Set(
          snapDes.docs.filter((d) => d.data().vendedor === vendedorNome).map((d) => d.data().empresa)
        ));

        // 3. Todos os agendamentos do vendedor (futuros + passados recentes para a Agenda)
        const snapAg = await getDocs(query(collection(db, 'agendamentosVisita'), where('vendedor', '==', vendedorNome)));
        const agMap = {};
        const agList = [];
        snapAg.docs.forEach((d) => {
          const a = d.data();
          if (!a.empresa || !a.dataAgendada) return;
          agList.push({ id: d.id, ...a });
          if (a.dataAgendada >= hoje) agMap[a.empresa] = a.dataAgendada;
        });
        setAgendamentosMap(agMap);
        setAgendamentosList(agList.sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada)));

        // 4. Prospectos Livres (global: prospectos > 30d sem visita)
        //    Clientes Inativos por visita (global: clientes > 90d sem visita)
        const livres = [];
        const inativosMap = {};
        Object.entries(mapaGlobal).forEach(([empresa, info]) => {
          if (todasDesistencias.has(empresa)) return;
          const dias = diasDesde(info.lastDate);
          if (dias === null) return;
          const isCliente = !!info.cnpj;
          if (!isCliente && dias >= LIMITE.prospecto.expira)
            livres.push({ empresa, dias, lastDate: info.lastDate, vendedor: info.vendedor, estado: info.estado });
          if (isCliente && dias >= LIMITE.cliente.expira)
            inativosMap[empresa] = { empresa, cnpj: info.cnpj, dias, lastDate: info.lastDate, vendedor: info.vendedor, estado: info.estado, motivo: 'visita' };
        });

        // 5. Clientes Inativos por pedido (global: clientes > 90d sem pedido)
        const snapTodosPed = await getDocs(collection(db, 'pedidosDia'));
        const porClientePed = {};
        snapTodosPed.docs.forEach((d) => {
          const p = d.data();
          if (!p.cliente || !p.ultimaCompra) return;
          const dias = diasDesde(p.ultimaCompra);
          if (dias === null) return;
          const resp = p.vendedorResponsavel || p.vendedor || '';
          if (!porClientePed[p.cliente] || dias < porClientePed[p.cliente].dias)
            porClientePed[p.cliente] = {
              dias, lastDate: p.ultimaCompra, vendedor: resp,
              estado: p.estado || extrairEstado(resp),
            };
        });
        Object.entries(porClientePed).forEach(([empresa, info]) => {
          if (todasDesistencias.has(empresa)) return;
          if (info.dias >= LIMITE.pedido.expira && !inativosMap[empresa])
            inativosMap[empresa] = { empresa, cnpj: '', dias: info.dias, lastDate: info.lastDate, vendedor: info.vendedor, estado: info.estado, motivo: 'pedido' };
        });

        setProspectosLivres(livres.sort((a, b) => b.dias - a.dias));
        setClientesInativos(Object.values(inativosMap).sort((a, b) => b.dias - a.dias));
      } catch (e) { console.error(e); }
    }
    carregarAlertas();
  }, [vendedorNome]);

  // ── alertas computados ────────────────────────────────────

  // Alertas de visita (relatorioVisitas)
  const alertasVisita = Object.entries(visitasMap)
    .filter(([emp]) => !desistidas.has(emp))
    .flatMap(([empresa, info]) => {
      const dias = diasDesde(info.lastDate);
      if (dias === null) return [];
      const isCliente = !!info.cnpj;
      const tipo = isCliente ? 'cliente' : 'prospecto';
      const L = isCliente ? LIMITE.cliente : LIMITE.prospecto;
      if (dias < L.amarelo || dias >= L.expira) return [];
      return [{ empresa, cnpj: info.cnpj, tipo, subTipo: 'visita', dias, lastDate: info.lastDate, nivel: nivelAlerta(dias, tipo) }];
    });

  // Alertas de pedido (pedidosDia — usa ultimaCompra por cliente)
  const alertasPedido = (() => {
    const porCliente = {};
    itens.forEach((p) => {
      if (!p.ultimaCompra || !p.cliente) return;
      const dias = diasDesde(p.ultimaCompra);
      if (dias === null) return;
      if (!porCliente[p.cliente] || dias < porCliente[p.cliente].dias)
        porCliente[p.cliente] = { dias, lastDate: p.ultimaCompra };
    });
    return Object.entries(porCliente)
      .filter(([emp]) => !desistidas.has(emp))
      .filter(([, i]) => i.dias >= LIMITE.pedido.amarelo && i.dias < LIMITE.pedido.expira)
      .map(([empresa, i]) => ({
        empresa, cnpj: '', tipo: 'cliente', subTipo: 'pedido',
        dias: i.dias, lastDate: i.lastDate, nivel: nivelAlerta(i.dias, 'pedido'),
      }));
  })();

  // Junta e ordena: vermelho primeiro, depois por mais dias
  const todosAlertas = [...alertasVisita, ...alertasPedido]
    .filter((a) => a.nivel && !agendamentosMap[a.empresa])
    .sort((a, b) => (a.nivel === b.nivel ? b.dias - a.dias : a.nivel === 'vermelho' ? -1 : 1));

  // Separados por nível
  const alertasVermelhos = todosAlertas.filter((a) => a.nivel === 'vermelho');
  const alertasAmarelos  = todosAlertas.filter((a) => a.nivel === 'amarelo');

  // Alertas com agendamento ativo (mostrados separados, mais discretos)
  const alertasAgendados = [...alertasVisita, ...alertasPedido]
    .filter((a) => a.nivel && agendamentosMap[a.empresa]);

  // ── ações ──────────────────────────────────────────────────
  async function confirmarAgendamento() {
    if (!modalAgendar || !dataAgend) return;
    setSalvandoAcao(true);
    try {
      await addDoc(collection(db, 'agendamentosVisita'), {
        vendedor: vendedorNome, empresa: modalAgendar.empresa,
        cnpj: modalAgendar.cnpj || '', tipo: modalAgendar.tipo,
        subTipo: modalAgendar.subTipo, dataAgendada: dataAgend,
        criadoEm: serverTimestamp(),
      });
      setAgendamentosMap((p) => ({ ...p, [modalAgendar.empresa]: dataAgend }));
      setAgendamentosList((prev) =>
        [...prev, {
          empresa: modalAgendar.empresa, cnpj: modalAgendar.cnpj || '',
          tipo: modalAgendar.tipo, subTipo: modalAgendar.subTipo,
          dataAgendada: dataAgend, vendedor: vendedorNome,
        }].sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada))
      );
      setModalAgendar(null);
    } catch (e) { console.error(e); }
    finally { setSalvandoAcao(false); }
  }

  async function confirmarDesistencia() {
    if (!modalDesistir) return;
    setSalvandoAcao(true);
    try {
      await addDoc(collection(db, 'desistencias'), {
        vendedor: vendedorNome, empresa: modalDesistir.empresa,
        cnpj: modalDesistir.cnpj || '', tipo: modalDesistir.tipo,
        dataDesistencia: hojeISO(),
        criadoEm: serverTimestamp(),
      });
      setDesistidas((p) => new Set([...p, modalDesistir.empresa]));
      setModalDesistir(null);
    } catch (e) { console.error(e); }
    finally { setSalvandoAcao(false); }
  }

  const grupos     = agruparPorCliente(itens);
  const pendentes  = grupos.filter((g) => !feitos.has(g.cliente));
  const concluidos = grupos.filter((g) =>  feitos.has(g.cliente));
  const pendentesAtivos = pendentes.filter((g) => g.produtos.some((p) => !parouDeUsar(p)));
  const morrendo        = pendentes.filter((g) => g.produtos.every((p) =>  parouDeUsar(p)));
  const primeiroNome    = vendedorNome ? vendedorNome.split(' ')[0] : '';
  const totalPendencias = todosAlertas.length + pendentesAtivos.length;
  const hoje            = hojeISO();
  const agendFuturos    = agendamentosList.filter((a) => a.dataAgendada >= hoje).length;

  function toggleFeito(c)    { setFeitos((p)    => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n; }); }
  function toggleExpandir(c) { setExpandidos((p) => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n; }); }

  function chaveAlerta(a)       { return `${a.empresa}__${a.subTipo}`; }
  function toggleAlertaFeito(a) {
    setAlertasFeitos((p) => { const n = new Set(p); const k = chaveAlerta(a); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  function renderAlertaGrid(alertas) {
    const ativos = alertas.filter((a) => !alertasFeitos.has(chaveAlerta(a)));
    const feitos_ = alertas.filter((a) =>  alertasFeitos.has(chaveAlerta(a)));
    return (
      <>
        {ativos.length > 0 && (
          <div style={s.alertaGrid}>
            {ativos.map((a) => (
              <AlertCard key={chaveAlerta(a)} alerta={a}
                agendado={agendamentosMap[a.empresa] || null}
                feito={false}
                onFeito={() => toggleAlertaFeito(a)}
                onInformar={() => window.open(FORM_VISITA_URL, '_blank')}
                onAgendar={() => { setModalAgendar(a); setDataAgend(''); }}
                onDesistir={() => setModalDesistir(a)} />
            ))}
          </div>
        )}
        {feitos_.length > 0 && (
          <div style={{ ...s.alertaGrid, marginTop: '6px', opacity: 0.45 }}>
            {feitos_.map((a) => (
              <AlertCard key={`c-${chaveAlerta(a)}`} alerta={a}
                agendado={null} feito={true}
                onFeito={() => toggleAlertaFeito(a)}
                onInformar={() => {}} onAgendar={() => {}} onDesistir={() => {}} />
            ))}
          </div>
        )}
      </>
    );
  }

  if (carregando) return <div style={s.centro}>Carregando atividades...</div>;
  if (erro)       return <div style={{ ...s.centro, color: '#dc2626' }}>{erro}</div>;

  return (
    <div style={{ paddingBottom: '40px' }}>
      <div style={s.saudacao}>
        <p style={s.dataLabel}>{dataHoje()}</p>
        <h2 style={s.titulo}>{saudacao()}{primeiroNome ? `, ${primeiroNome}` : ''}!</h2>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
          <span style={{ ...s.pill, background: '#fee2e2', color: '#dc2626' }}>
            {totalPendencias} pendente{totalPendencias !== 1 ? 's' : ''}
          </span>
          <span style={{ ...s.pill, background: '#dcfce7', color: '#16a34a' }}>
            {concluidos.length} concluído{concluidos.length !== 1 ? 's' : ''}
          </span>
        </div>
        {/* ── Abas Hoje / Agenda ── */}
        <div style={s.tabBar}>
          <button style={aba === 'hoje' ? s.tabAtivo : s.tabInativo} onClick={() => setAba('hoje')}>
            📋 Hoje
          </button>
          <button style={aba === 'agenda' ? s.tabAtivo : s.tabInativo} onClick={() => setAba('agenda')}>
            🗓️ Agenda{agendFuturos > 0 && <span style={s.tabBadge}>{agendFuturos}</span>}
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════ */}
      {/* ABA: HOJE                                          */}
      {/* ═══════════════════════════════════════════════════ */}
      {aba === 'hoje' && <>

      {/* ── Pedidos realizados hoje ──────────────────────── */}
      {pedidosHoje.length > 0 && (
        <div style={{ ...s.grupo, marginTop: '12px' }}>
          <p style={s.grupoLabel}>
            📦 Pedidos de hoje
            <span style={{ marginLeft: '8px', fontWeight: '600', color: '#16a34a', background: '#dcfce7', padding: '1px 8px', borderRadius: '20px', fontSize: '11px', textTransform: 'none', letterSpacing: 0 }}>
              {pedidosHoje.length} {pedidosHoje.length === 1 ? 'venda' : 'vendas'} · {pedidosHoje.reduce((s, v) => s + v.totalFat, 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </span>
          </p>
          {pedidosHoje.map((v) => (
            <div key={v.key} style={{
              background: '#fff',
              borderRadius: '12px',
              padding: '13px 14px',
              marginBottom: '8px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.07)',
              borderLeft: '4px solid #16a34a',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: '700', color: '#111827' }}>{v.cliente}</p>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>#{v.numeroVenda}</span>
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>{v.produtos.length} {v.produtos.length === 1 ? 'produto' : 'produtos'}</span>
                    {v.estado && <span style={{ fontSize: '11px', color: '#9ca3af' }}>{v.estado}</span>}
                    {v.situacao && (
                      <span style={{ fontSize: '11px', fontWeight: '600', padding: '1px 7px', borderRadius: '20px', background: '#f3f4f6', color: '#6b7280' }}>
                        {v.situacao}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <p style={{ margin: '0 0 2px', fontSize: '15px', fontWeight: '700', color: '#111827' }}>
                    {v.totalFat.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </p>
                  <p style={{ margin: 0, fontSize: '12px', color: '#16a34a', fontWeight: '600' }}>
                    Com. {v.totalCom.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Sugestão de pedidos do dia ───────────────────── */}
      {pendentesAtivos.length > 0 && (
        <div style={{ ...s.grupo, marginTop: '12px' }}>
          <p style={s.grupoLabel}>🛒 Sugestão de pedidos do dia</p>
          {pendentesAtivos.map((g) => (
            <ClienteCard key={g.cliente} grupo={g} feito={false}
              contato={contatos[g.cliente] || ''} vendedor={primeiroNome}
              expandido={expandidos.has(g.cliente)}
              onToggle={toggleFeito} onExpandir={toggleExpandir} />
          ))}
        </div>
      )}

      {concluidos.length > 0 && (
        <div style={s.grupo}>
          <p style={{ ...s.grupoLabel, color: '#9ca3af' }}>Concluídos</p>
          {concluidos.map((g) => (
            <ClienteCard key={g.cliente} grupo={g} feito={true}
              contato={contatos[g.cliente] || ''} vendedor={primeiroNome}
              expandido={expandidos.has(g.cliente)}
              onToggle={toggleFeito} onExpandir={toggleExpandir} />
          ))}
        </div>
      )}

      {morrendo.length > 0 && (
        <div style={{ ...s.grupo, opacity: 0.45 }}>
          <p style={{ ...s.grupoLabel, color: '#9ca3af' }}>Em desuso</p>
          {morrendo.map((g) => (
            <ClienteCard key={g.cliente} grupo={g} feito={false}
              contato={contatos[g.cliente] || ''} vendedor={primeiroNome}
              expandido={expandidos.has(g.cliente)}
              onToggle={toggleFeito} onExpandir={toggleExpandir} />
          ))}
        </div>
      )}

      {/* ── Alertas de visita / pedido ───────────────────── */}
      {alertasVermelhos.length > 0 && (
        <div style={{ ...s.grupo, marginTop: '12px' }}>
          <p style={{ ...s.grupoLabel, color: '#dc2626' }}>🔴 Urgente</p>
          {alertasVermelhos.some((a) => a.subTipo !== 'pedido') && (
            <><p style={s.subLabel}>📍 Sem visita</p>
            {renderAlertaGrid(alertasVermelhos.filter((a) => a.subTipo !== 'pedido'))}</>
          )}
          {alertasVermelhos.some((a) => a.subTipo === 'pedido') && (
            <><p style={{ ...s.subLabel, marginTop: '10px' }}>🛒 Sem pedido</p>
            {renderAlertaGrid(alertasVermelhos.filter((a) => a.subTipo === 'pedido'))}</>
          )}
        </div>
      )}

      {alertasAmarelos.length > 0 && (
        <div style={{ ...s.grupo, marginTop: '10px' }}>
          <p style={{ ...s.grupoLabel, color: '#d97706' }}>🟡 Atenção</p>
          {alertasAmarelos.some((a) => a.subTipo !== 'pedido') && (
            <><p style={s.subLabel}>📍 Sem visita</p>
            {renderAlertaGrid(alertasAmarelos.filter((a) => a.subTipo !== 'pedido'))}</>
          )}
          {alertasAmarelos.some((a) => a.subTipo === 'pedido') && (
            <><p style={{ ...s.subLabel, marginTop: '10px' }}>🛒 Sem pedido</p>
            {renderAlertaGrid(alertasAmarelos.filter((a) => a.subTipo === 'pedido'))}</>
          )}
        </div>
      )}

      {alertasAgendados.length > 0 && (
        <div style={{ ...s.grupo, marginTop: '8px' }}>
          <p style={{ ...s.grupoLabel, color: '#2563eb' }}>📅 Visitas agendadas</p>
          {renderAlertaGrid(alertasAgendados)}
        </div>
      )}

      {/* ── Prospectos Livres (agrupados por estado) ──────── */}
      {prospectosLivres.length > 0 && (
        <div style={{ ...s.grupo, marginTop: '16px' }}>
          <button onClick={() => setMostrarPL((v) => !v)} style={s.toggleBtn}>
            <span>🔓 Prospectos Livres</span>
            <span style={s.toggleBadge}>{prospectosLivres.length}</span>
            <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6b7280' }}>{mostrarPL ? '▲' : '▼'}</span>
          </button>
          {mostrarPL && (
            <div style={{ marginTop: '6px' }}>
              {agruparPorEstado(prospectosLivres).map(([estado, lista]) => (
                <GrupoEstado key={estado} estado={estado} lista={lista} tipo="prospecto"
                  onInformar={() => window.open(FORM_VISITA_URL, '_blank')} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Clientes Inativos (agrupados por estado) ──────── */}
      {clientesInativos.length > 0 && (
        <div style={{ ...s.grupo, marginTop: '10px' }}>
          <button onClick={() => setMostrarCI((v) => !v)} style={s.toggleBtn}>
            <span>🚨 Clientes Inativos</span>
            <span style={s.toggleBadge}>{clientesInativos.length}</span>
            <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6b7280' }}>{mostrarCI ? '▲' : '▼'}</span>
          </button>
          {mostrarCI && (
            <div style={{ marginTop: '6px' }}>
              {agruparPorEstado(clientesInativos).map(([estado, lista]) => (
                <GrupoEstado key={estado} estado={estado} lista={lista} tipo="cliente"
                  onInformar={() => window.open(FORM_VISITA_URL, '_blank')} />
              ))}
            </div>
          )}
        </div>
      )}

      {grupos.length === 0 && todosAlertas.length === 0 && pedidosHoje.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 16px' }}>
          <p style={{ fontSize: '32px', margin: 0 }}>✅</p>
          <p style={{ color: '#6b7280', marginTop: '8px' }}>Nenhuma atividade para hoje.</p>
        </div>
      )}

      </> /* fim aba hoje */}

      {/* ═══════════════════════════════════════════════════ */}
      {/* ABA: AGENDA                                        */}
      {/* ═══════════════════════════════════════════════════ */}
      {aba === 'agenda' && (
        <AgendaView
          agendamentos={agendamentosList}
          hoje={hoje}
          onInformar={() => window.open(FORM_VISITA_URL, '_blank')}
        />
      )}

      {/* ── Modal: Agendar visita ──────────────────────────── */}
      {modalAgendar && (
        <div style={sa.overlay}>
          <div style={sa.modal}>
            <h3 style={{ margin: '0 0 2px', fontSize: '17px', fontWeight: '800' }}>Agendar Visita</h3>
            <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: '13px' }}>
              {modalAgendar.empresa}
              <span style={{ marginLeft: '6px', fontSize: '11px', fontWeight: '700',
                color: modalAgendar.nivel === 'vermelho' ? '#dc2626' : '#d97706',
                background: modalAgendar.nivel === 'vermelho' ? '#fee2e2' : '#fef3c7',
                padding: '1px 7px', borderRadius: '20px' }}>
                {modalAgendar.dias}d sem {modalAgendar.subTipo === 'pedido' ? 'pedido' : 'visita'}
              </span>
            </p>

            <p style={sa.label}>Data da visita</p>
            <input type="date"
              value={dataAgend}
              min={hojeISO()}
              max={modalAgendar.tipo !== 'pedido' ? maxDataAgend(modalAgendar.lastDate, modalAgendar.tipo, modalAgendar.nivel) : undefined}
              onChange={(e) => setDataAgend(e.target.value)}
              style={{ ...sa.input, marginBottom: '6px' }}
            />
            {modalAgendar.tipo !== 'pedido' && (
              <p style={{ margin: '0 0 18px', fontSize: '11px', color: '#9ca3af' }}>
                Prazo máximo: {maxDataAgend(modalAgendar.lastDate, modalAgendar.tipo, modalAgendar.nivel).split('-').reverse().join('/')}
              </p>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <button onClick={() => setModalAgendar(null)} style={sa.btnCancel}>Cancelar</button>
              <button onClick={confirmarAgendamento} disabled={!dataAgend || salvandoAcao} style={sa.btnConfirm}>
                {salvandoAcao ? 'Salvando...' : '✓ Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Desistir ────────────────────────────────── */}
      {modalDesistir && (
        <div style={sa.overlay}>
          <div style={sa.modal}>
            <h3 style={{ margin: '0 0 4px', fontSize: '17px', fontWeight: '800' }}>
              {modalDesistir.tipo === 'prospecto' ? 'Desistir do Prospecto' : 'Desistir do Cliente'}
            </h3>
            <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: '13px' }}>{modalDesistir.empresa}</p>

            <div style={{ background: '#fef3c7', borderRadius: '10px', padding: '12px', marginBottom: '18px' }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#92400e', fontWeight: '600' }}>
                {modalDesistir.tipo === 'prospecto'
                  ? '⚠️ Este prospecto será movido para "Prospectos Livres" e ficará disponível para outros vendedores.'
                  : '⚠️ Este cliente será marcado como "Inativo" e ficará disponível na lista de clientes inativos.'}
              </p>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setModalDesistir(null)} style={sa.btnCancel}>Cancelar</button>
              <button onClick={confirmarDesistencia} disabled={salvandoAcao}
                style={{ ...sa.btnConfirm, background: '#dc2626' }}>
                {salvandoAcao ? 'Salvando...' : 'Confirmar desistência'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── aba agenda ───────────────────────────────────────────

function AgendaView({ agendamentos, hoje, onInformar }) {
  const amanha = (() => { const d = new Date(hoje + 'T00:00:00'); d.setDate(d.getDate() + 1); return dataParaISO(d); })();
  const semana = (() => { const d = new Date(hoje + 'T00:00:00'); d.setDate(d.getDate() + 7); return dataParaISO(d); })();

  const deHoje    = agendamentos.filter((a) => a.dataAgendada === hoje);
  const proximos  = agendamentos.filter((a) => a.dataAgendada > hoje && a.dataAgendada <= semana);
  const depois    = agendamentos.filter((a) => a.dataAgendada > semana);
  const passados  = agendamentos.filter((a) => a.dataAgendada < hoje).reverse(); // mais recente primeiro

  function GrupoAgenda({ titulo, cor, lista }) {
    if (!lista.length) return null;
    return (
      <div style={{ ...s.grupo, marginTop: '14px' }}>
        <p style={{ ...s.grupoLabel, color: cor }}>{titulo}</p>
        {lista.map((a, i) => (
          <AgendaCard key={`${a.empresa}-${a.dataAgendada}-${i}`} ag={a} passado={a.dataAgendada < hoje} onInformar={onInformar} />
        ))}
      </div>
    );
  }

  if (!agendamentos.length)
    return (
      <div style={{ textAlign: 'center', padding: '60px 16px' }}>
        <p style={{ fontSize: '32px', margin: 0 }}>📅</p>
        <p style={{ color: '#6b7280', marginTop: '8px' }}>Nenhuma visita agendada.</p>
        <p style={{ color: '#9ca3af', fontSize: '12px' }}>Use "Agendar visita" nos alertas para criar agendamentos.</p>
      </div>
    );

  return (
    <div>
      <GrupoAgenda titulo="📍 Hoje"            cor="#dc2626"  lista={deHoje} />
      <GrupoAgenda titulo="📅 Esta semana"     cor="#d97706"  lista={proximos} />
      <GrupoAgenda titulo="🗓️ Mais adiante"   cor="#2563eb"  lista={depois} />
      <GrupoAgenda titulo="⏰ Passadas"        cor="#9ca3af"  lista={passados} />
    </div>
  );
}

function AgendaCard({ ag, passado, onInformar }) {
  const isProspecto = ag.tipo === 'prospecto';
  const isPedido    = ag.subTipo === 'pedido';
  const cor         = isProspecto ? '#7c3aed' : '#2563eb';
  const bg          = isProspecto ? '#f5f3ff' : '#eff6ff';

  return (
    <div style={{
      background: passado ? '#f9fafb' : '#fff',
      border: '1px solid #e5e7eb',
      borderLeft: `4px solid ${passado ? '#d1d5db' : cor}`,
      borderRadius: '10px', padding: '12px 14px', marginBottom: '8px',
      opacity: passado ? 0.7 : 1,
      display: 'flex', alignItems: 'center', gap: '12px',
    }}>
      {/* Data em destaque */}
      <div style={{
        flexShrink: 0, textAlign: 'center', minWidth: '42px',
        background: passado ? '#f3f4f6' : bg,
        borderRadius: '8px', padding: '6px 4px',
      }}>
        <p style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: passado ? '#9ca3af' : cor, lineHeight: 1 }}>
          {ag.dataAgendada.slice(8)}
        </p>
        <p style={{ margin: 0, fontSize: '10px', fontWeight: '600', color: passado ? '#9ca3af' : cor }}>
          {['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][parseInt(ag.dataAgendada.slice(5, 7)) - 1]}
        </p>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: '0 0 3px', fontSize: '13px', fontWeight: '700', color: passado ? '#6b7280' : '#111827' }}>
          {ag.empresa}
        </p>
        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          <span style={{
            fontSize: '10px', fontWeight: '700', padding: '1px 7px', borderRadius: '20px',
            background: isProspecto ? '#ede9fe' : '#dbeafe',
            color: isProspecto ? '#7c3aed' : '#2563eb',
          }}>
            {isProspecto ? 'Prospecto' : 'Cliente'}
          </span>
          <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: '600' }}>
            {isPedido ? '🛒 sem pedido' : '📍 sem visita'}
          </span>
        </div>
      </div>

      {/* Ação */}
      {!passado ? (
        <button onClick={onInformar} style={{
          flexShrink: 0, background: cor, color: '#fff', border: 'none',
          borderRadius: '8px', padding: '7px 10px', fontSize: '11px',
          fontWeight: '700', cursor: 'pointer',
        }}>
          📝 Informar
        </button>
      ) : (
        <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', flexShrink: 0 }}>
          Não informada
        </span>
      )}
    </div>
  );
}

// ── grupo de estado (acordeão) ───────────────────────────

function GrupoEstado({ estado, lista, tipo, onInformar }) {
  const [aberto, setAberto] = useState(false);
  const isProspecto = tipo === 'prospecto';
  const cor = isProspecto ? '#7c3aed' : '#dc2626';

  return (
    <div style={{ marginBottom: '6px' }}>
      <button
        onClick={() => setAberto((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
          background: aberto ? (isProspecto ? '#f5f3ff' : '#fff1f2') : '#f8fafc',
          border: `1.5px solid ${aberto ? cor : '#e5e7eb'}`,
          borderRadius: aberto ? '10px 10px 0 0' : '10px',
          padding: '10px 14px', cursor: 'pointer',
          transition: 'all 0.15s',
        }}
      >
        <span style={{ fontSize: '13px', fontWeight: '800', color: cor, minWidth: '32px' }}>
          {estado}
        </span>
        <span style={{
          fontSize: '11px', fontWeight: '700', padding: '1px 8px', borderRadius: '20px',
          background: aberto ? cor : '#e5e7eb',
          color: aberto ? '#fff' : '#6b7280',
        }}>
          {lista.length} {tipo === 'prospecto' ? 'prospecto' : 'cliente'}{lista.length !== 1 ? 's' : ''}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#9ca3af' }}>
          {aberto ? '▲' : '▼'}
        </span>
      </button>

      {aberto && (
        <div style={{
          border: `1.5px solid ${cor}`, borderTop: 'none',
          borderRadius: '0 0 10px 10px', padding: '8px 8px 4px',
          background: '#fff',
        }}>
          {lista.map((p) => (
            <CardExpirado key={p.empresa} item={p} tipo={tipo} onInformar={onInformar} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── card de item expirado (Prospectos Livres / Clientes Inativos) ──

function CardExpirado({ item, tipo, onInformar }) {
  const isProspecto = tipo === 'prospecto';
  const cor   = isProspecto ? '#7c3aed' : '#dc2626';
  const bg    = isProspecto ? '#f5f3ff' : '#fff1f2';
  const borda = isProspecto ? '#c4b5fd' : '#fca5a5';
  const motivoLabel = item.motivo === 'pedido' ? 'sem pedido' : 'sem visita';

  return (
    <div style={{
      background: bg, border: `1px solid ${borda}`, borderLeft: `4px solid ${cor}`,
      borderRadius: '10px', padding: '11px 14px', marginBottom: '8px',
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: '0 0 3px', fontSize: '13px', fontWeight: '700', color: '#111827' }}>
          {item.empresa}
        </p>
        <span style={{ fontSize: '11px', color: '#6b7280' }}>
          {item.dias}d {motivoLabel}
        </span>
      </div>
      <button onClick={onInformar} style={{
        flexShrink: 0, background: cor, color: '#fff', border: 'none',
        borderRadius: '8px', padding: '7px 12px', fontSize: '12px',
        fontWeight: '700', cursor: 'pointer',
      }}>
        📝 Visitar
      </button>
    </div>
  );
}

// ── card de alerta (grade compacta) ──────────────────────

function AlertCard({ alerta, agendado, feito, onFeito, onInformar, onAgendar, onDesistir }) {
  const isVermelho  = alerta.nivel === 'vermelho';
  const isProspecto = alerta.tipo === 'prospecto';
  const isPedido    = alerta.subTipo === 'pedido';

  const nivCor  = isVermelho  ? '#dc2626' : '#d97706';
  const tipoCor = isProspecto ? '#7c3aed' : '#2563eb';
  const tipoBg  = isProspecto ? '#ede9fe' : '#dbeafe';

  // aviso de expiração próxima (≤ 7 dias)
  const restam = !isPedido ? (() => {
    const L = isProspecto ? LIMITE.prospecto : LIMITE.cliente;
    return L.expira - alerta.dias;
  })() : null;

  return (
    <div style={{
      background: feito ? '#f9fafb' : '#fff',
      borderRadius: '10px',
      border: '1px solid #e5e7eb',
      borderTop: `3px solid ${feito ? '#d1d5db' : nivCor}`,
      padding: '10px',
      display: 'flex', flexDirection: 'column', gap: '5px',
      boxShadow: feito ? 'none' : '0 1px 3px rgba(0,0,0,0.07)',
    }}>

      {/* Nome */}
      <p style={{
        margin: 0, fontSize: '12px', fontWeight: '700',
        color: feito ? '#9ca3af' : '#111827',
        lineHeight: 1.3,
        overflow: 'hidden', display: '-webkit-box',
        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        textDecoration: feito ? 'line-through' : 'none',
      }}>
        {alerta.empresa}
      </p>

      {/* Badges */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <span style={{
          alignSelf: 'flex-start', fontSize: '10px', fontWeight: '700',
          padding: '1px 6px', borderRadius: '20px',
          background: feito ? '#f3f4f6' : tipoBg,
          color: feito ? '#9ca3af' : tipoCor,
        }}>
          {isProspecto ? 'Prospecto' : 'Cliente'}
        </span>
        <span style={{
          alignSelf: 'flex-start', fontSize: '10px', fontWeight: '700',
          padding: '1px 6px', borderRadius: '20px',
          background: feito ? '#f3f4f6' : (isVermelho ? '#fee2e2' : '#fef3c7'),
          color: feito ? '#9ca3af' : nivCor,
        }}>
          {alerta.dias}d {isPedido ? 'sem pedido' : 'sem visita'}
        </span>
        {agendado && !feito && (
          <span style={{ fontSize: '10px', fontWeight: '600', color: '#2563eb' }}>
            📅 {agendado.split('-').reverse().join('/')}
          </span>
        )}
        {restam !== null && restam <= 7 && !feito && (
          <span style={{ fontSize: '10px', fontWeight: '700', color: '#dc2626' }}>
            ⏰ {restam}d p/ expirar
          </span>
        )}
      </div>

      {/* Ações */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginTop: 'auto', paddingTop: '4px', borderTop: '1px solid #f0f0f0' }}>
        <input
          type="checkbox" checked={feito} onChange={onFeito}
          title="Marcar como concluído"
          style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: '#16a34a', flexShrink: 0 }}
        />
        <span style={{ flex: 1 }} />
        {!feito && <>
          <button onClick={onInformar} title="Informar visita" style={sa.iconBtn}>📝</button>
          <button onClick={onAgendar}  title={agendado ? 'Reagendar visita' : 'Agendar visita'} style={sa.iconBtn}>📅</button>
          <button onClick={onDesistir} title={`Desistir do ${isProspecto ? 'Prospecto' : 'Cliente'}`}
            style={{ ...sa.iconBtn, color: '#dc2626', fontWeight: '900' }}>✕</button>
        </>}
      </div>
    </div>
  );
}

// ── 1ª camada: card do cliente ────────────────────────────

function ClienteCard({ grupo, feito, expandido, contato, vendedor, onToggle, onExpandir }) {
  const tipo        = resolverTipo(grupo.tipo);
  const ativos      = grupo.produtos.filter((p) => !parouDeUsar(p));
  const parados     = grupo.produtos.filter((p) =>  parouDeUsar(p));
  const tGlobal     = tendenciaGlobal(ativos);
  const [selecionados, setSelecionados] = useState(new Set());
  const [copiado1, setCopiado1] = useState(false);
  const [copiado2, setCopiado2] = useState(false);

  function toggleSelecionado(id) {
    setSelecionados((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // Descarta contato se for igual ao nome do restaurante (dado não preenchido)
  const contatoValido = contato && contato.trim().toLowerCase() !== grupo.cliente.trim().toLowerCase()
    ? contato : null;
  const nomeContato = contatoValido ? contatoValido.split(' ')[0] : null;
  const saudacaoMsg = nomeContato ? `Oi, ${nomeContato}!` : 'Oi!';

  function gerarMsg1() {
    const lista = ativos.map((p) => {
      const qtd = p.qtdSugerida ? ` (${p.qtdSugerida} un.)` : '';
      return `• ${p.produto}${qtd}`;
    }).join('\n');
    const saud = saudacao();
    const nomeVend = vendedor || 'nosso vendedor';
    return `${saud}${nomeContato ? `, ${nomeContato}` : ''}! Tudo bem?\n\nEsta é uma mensagem automática do nosso sistema de controle de estoque, para ajudar o ${nomeVend} nas vendas.\n\nIdentificamos que você pode precisar repor:\n${lista}\n\nÉ só um aviso pra te ajudar a não faltar produto 😉\nSe precisar, estamos por aqui!`;
  }

  function gerarMsg2() {
    const produtosSel = parados.filter((p) => selecionados.has(p.id));
    if (!produtosSel.length) return '';
    const lista = produtosSel.map((p) => `• ${p.produto}`).join('\n');
    return `${saudacaoMsg}\n\nNotei que faz um tempo que você não pede estes produtos:\n\n${lista}\n\nAinda tem interesse em algum deles?`;
  }

  function copiar(msg, setCopied) {
    navigator.clipboard.writeText(msg).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const msg1 = gerarMsg1();
  const msg2 = gerarMsg2();

  return (
    <div style={{ marginBottom: '12px' }}>
      {/* Cabeçalho do cliente */}
      <div style={{
        background: '#fff',
        borderRadius: expandido ? '12px 12px 0 0' : '12px',
        padding: '14px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.07)',
        borderLeft: `4px solid ${tipo.cor}`,
        opacity: feito ? 0.55 : 1,
        display: 'flex', alignItems: 'center', gap: '10px',
      }}>
        <button onClick={() => onExpandir(grupo.cliente)} style={{
          flexShrink: 0, width: '26px', height: '26px', borderRadius: '6px',
          border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: '700',
          background: expandido ? '#0f3460' : '#f1f5f9',
          color: expandido ? '#fff' : '#0f3460',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {expandido ? '−' : '+'}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '3px' }}>
            <span style={{ fontSize: '14px', fontWeight: '700', color: '#111827', textDecoration: feito ? 'line-through' : 'none' }}>
              {grupo.cliente}
            </span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: tGlobal.cor }}>{tGlobal.icon}</span>
            <span style={{ fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px', background: tipo.bg, color: tipo.cor }}>
              {tipo.icon} {tipo.label}
            </span>
          </div>
          <span style={{ fontSize: '12px', color: '#6b7280' }}>
            {ativos.length} {ativos.length === 1 ? 'produto' : 'produtos'}
            {parados.length > 0 && <span style={{ color: '#9ca3af' }}> · {parados.length} parou de usar</span>}
          </span>
        </div>

        <button onClick={() => onToggle(grupo.cliente)} style={{
          flexShrink: 0, width: '28px', height: '28px', borderRadius: '50%',
          border: `2px solid ${feito ? '#16a34a' : '#d1d5db'}`,
          background: feito ? '#16a34a' : '#fff',
          color: feito ? '#fff' : '#9ca3af',
          cursor: 'pointer', fontSize: '14px', fontWeight: '700',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {feito ? '✓' : ''}
        </button>
      </div>

      {/* 2ª camada */}
      {expandido && (
        <div style={{ background: '#f8fafc', borderRadius: '0 0 12px 12px', border: '1px solid #e5e7eb', borderTop: 'none' }}>

          {/* Produtos ativos */}
          {ativos.map((p, i) => (
            <ProdutoAtivo key={p.id} p={p} zebra={i % 2 === 0} ultimo={i === ativos.length - 1 && parados.length === 0} />
          ))}

          {/* Produtos que pararam */}
          {parados.length > 0 && (
            <>
              <div style={{ padding: '8px 14px 4px', background: '#f1f5f9', borderTop: ativos.length > 0 ? '1px solid #e5e7eb' : 'none' }}>
                <span style={{ fontSize: '10px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Parou de usar
                </span>
              </div>
              {parados.map((p, i) => (
                <ProdutoParado key={p.id} p={p} zebra={i % 2 === 0} ultimo={i === parados.length - 1}
                  selecionado={selecionados.has(p.id)} onToggle={toggleSelecionado} />
              ))}
            </>
          )}

          {/* Mensagens WhatsApp */}
          <div style={{ padding: '14px', borderTop: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: '10px' }}>

            {/* Mensagem 1 — produtos ativos */}
            {ativos.length > 0 && (
              <div>
                <p style={s.msgLabel}>💬 Mensagem de sugestão de pedido</p>
                <div
                  onClick={() => copiar(msg1, setCopiado1)}
                  style={{ ...s.msgBox, borderColor: copiado1 ? '#16a34a' : '#e5e7eb' }}
                >
                  <pre style={s.msgTexto}>{msg1}</pre>
                  <div style={s.msgRodape}>
                    <span style={{ color: copiado1 ? '#16a34a' : '#9ca3af', fontWeight: '600' }}>
                      {copiado1 ? '✓ Copiado!' : '📋 Toque para copiar'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Mensagem 2 — reativação (só aparece se há selecionados) */}
            {parados.length > 0 && (
              <div>
                <p style={s.msgLabel}>💬 Mensagem de reativação
                  <span style={{ fontWeight: '400', color: '#9ca3af' }}> — selecione os produtos abaixo</span>
                </p>
                {selecionados.size > 0 ? (
                  <div
                    onClick={() => copiar(msg2, setCopiado2)}
                    style={{ ...s.msgBox, borderColor: copiado2 ? '#16a34a' : '#e5e7eb' }}
                  >
                    <pre style={s.msgTexto}>{msg2}</pre>
                    <div style={s.msgRodape}>
                      <span style={{ color: copiado2 ? '#16a34a' : '#9ca3af', fontWeight: '600' }}>
                        {copiado2 ? '✓ Copiado!' : '📋 Toque para copiar'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div style={{ ...s.msgBox, background: '#f9fafb', cursor: 'default' }}>
                    <p style={{ margin: 0, fontSize: '12px', color: '#9ca3af', textAlign: 'center', padding: '8px 0' }}>
                      Selecione produtos "parou de usar" para gerar a mensagem
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── produto ativo ─────────────────────────────────────────

function ProdutoAtivo({ p, zebra, ultimo }) {
  const st = seta(p.tendencia);
  const ce = corEstoque(p.statusEstoque);

  return (
    <div style={{
      padding: '9px 14px', display: 'flex', alignItems: 'center', gap: '10px',
      background: zebra ? '#f8fafc' : '#f1f5f9',
      borderBottom: ultimo ? 'none' : '1px solid #e5e7eb',
    }}>
      <span style={{ flex: 1, fontSize: '13px', fontWeight: '600', color: '#111827' }}>{p.produto}</span>
      {p.qtdSugerida != null && p.qtdSugerida !== '' && (
        <span style={{ fontSize: '12px', fontWeight: '700', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '20px', whiteSpace: 'nowrap' }}>
          Qtd: {p.qtdSugerida}
        </span>
      )}
      {ce && p.statusEstoque && String(p.statusEstoque).trim() !== '' && (
        <span style={{ fontSize: '12px', fontWeight: '700', color: ce.cor, background: ce.bg, padding: '2px 8px', borderRadius: '20px', whiteSpace: 'nowrap' }}>
          {p.statusEstoque}
        </span>
      )}
      <span style={{ fontSize: '16px', fontWeight: '800', color: st.cor, minWidth: '16px', textAlign: 'center' }}>{st.icon}</span>
    </div>
  );
}

// ── produto parado (com checkbox + última compra) ─────────

function ProdutoParado({ p, zebra, ultimo, selecionado, onToggle }) {
  const ult = formatarData(p.ultimaCompra);

  return (
    <div style={{
      padding: '9px 14px', display: 'flex', alignItems: 'center', gap: '10px',
      background: zebra ? '#f8fafc' : '#f1f5f9',
      borderBottom: ultimo ? 'none' : '1px solid #e5e7eb',
      opacity: 0.65,
    }}>
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={selecionado}
        onChange={() => onToggle(p.id)}
        style={{ flexShrink: 0, width: '15px', height: '15px', cursor: 'pointer', accentColor: '#0f3460' }}
      />
      <span style={{ flex: 1, fontSize: '13px', fontWeight: '500', color: '#6b7280', fontStyle: 'italic' }}>{p.produto}</span>
      {ult && (
        <span style={{ fontSize: '11px', color: '#9ca3af', whiteSpace: 'nowrap' }}>Último: {ult}</span>
      )}
    </div>
  );
}

// ── estilos ───────────────────────────────────────────────

const s = {
  centro:     { padding: '40px 16px', textAlign: 'center', color: '#6b7280' },
  saudacao:   { padding: '20px 16px 16px', borderBottom: '1px solid #f0f0f0', marginBottom: '8px' },
  dataLabel:  { margin: '0 0 2px', fontSize: '12px', color: '#9ca3af', textTransform: 'capitalize' },
  titulo:     { margin: '0 0 10px', fontSize: '20px', fontWeight: '700', color: '#111827' },
  pill:       { fontSize: '12px', fontWeight: '600', padding: '4px 12px', borderRadius: '20px' },
  grupo:      { padding: '0 16px', marginTop: '16px' },
  grupoLabel: { fontSize: '11px', fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' },
  subLabel:    { margin: '0 0 6px', fontSize: '11px', fontWeight: '600', color: '#6b7280' },
  alertaGrid:  {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginBottom: '4px',
  },
  estadoLabel: {
    margin: '0 0 6px', fontSize: '11px', fontWeight: '800', color: '#374151',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    borderLeft: '3px solid #0f3460', paddingLeft: '8px',
  },
  tabBar:    {
    display: 'flex', gap: '6px',
  },
  tabAtivo:  {
    flex: 1, padding: '8px 0', border: 'none', borderRadius: '8px',
    background: '#0f3460', color: '#fff', fontSize: '13px', fontWeight: '700',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  },
  tabInativo: {
    flex: 1, padding: '8px 0', border: '1.5px solid #e5e7eb', borderRadius: '8px',
    background: '#f8fafc', color: '#6b7280', fontSize: '13px', fontWeight: '600',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  },
  tabBadge: {
    background: '#dc2626', color: '#fff', borderRadius: '20px',
    padding: '1px 6px', fontSize: '10px', fontWeight: '800',
  },
  toggleBtn:  {
    width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
    background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '10px',
    padding: '10px 14px', cursor: 'pointer', fontSize: '12px', fontWeight: '700', color: '#374151',
  },
  toggleBadge: {
    background: '#e5e7eb', color: '#374151', borderRadius: '20px',
    padding: '1px 8px', fontSize: '11px', fontWeight: '700',
  },
  msgLabel:   { margin: '0 0 6px', fontSize: '11px', fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' },
  msgBox:     {
    background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: '10px',
    padding: '12px', cursor: 'pointer', transition: 'border-color 0.2s',
  },
  msgTexto:   { margin: 0, fontSize: '12px', color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'inherit' },
  msgRodape:  { marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #f0f0f0', fontSize: '11px', textAlign: 'right' },
};

// ── estilos dos modais de alerta ──────────────────────────

const sa = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: '16px',
  },
  modal: {
    background: '#fff', borderRadius: '16px', padding: '24px',
    width: '100%', maxWidth: '380px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
  },
  label: {
    margin: '0 0 6px', fontSize: '12px', fontWeight: '700',
    color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  input: {
    width: '100%', boxSizing: 'border-box',
    border: '1.5px solid #d1d5db', borderRadius: '8px',
    padding: '10px 12px', fontSize: '14px', color: '#111827',
    outline: 'none',
  },
  btnCancel: {
    flex: 1, padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
    fontWeight: '700', cursor: 'pointer', border: '1.5px solid #e5e7eb',
    background: '#f9fafb', color: '#6b7280',
  },
  btnConfirm: {
    flex: 2, padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
    fontWeight: '700', cursor: 'pointer', border: 'none',
    background: '#0f3460', color: '#fff',
  },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: '15px', padding: '3px 4px', borderRadius: '6px',
    lineHeight: 1, color: '#374151',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
};

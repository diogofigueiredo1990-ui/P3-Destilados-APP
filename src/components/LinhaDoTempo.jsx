import { useState, useEffect, memo, useCallback, useMemo } from 'react';
import { collection, query, where, getDocs, getDocsFromServer, getDoc, doc, addDoc, deleteDoc, serverTimestamp, documentId } from 'firebase/firestore';
import { hojeISO, dataParaISO } from '../utils/data';
import { db } from '../firebase/config';

const FORM_VISITA_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScV0qcBHN3VXHTyxSLWgV6yPGW-2o_ZY5cr_DkSVnXgjZxlwQ/viewform';

// Limiares de alerta (dias)
const LIMITE = {
  prospecto: { amarelo: 15, vermelho: 23, expira: 30 },
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

// Normaliza qualquer formato de data para ISO (YYYY-MM-DD) ou null
function normalizarData(val) {
  if (!val) return null;
  // ISO string: "2026-03-12" ou "2026-03-12T..."
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}/)) return val.slice(0, 10);
  // BR string: "12/03/2026"
  if (typeof val === 'string' && val.match(/^\d{2}\/\d{2}\/\d{4}/)) {
    const [d, m, y] = val.split('/'); return `${y}-${m}-${d}`;
  }
  // Firestore Timestamp com .toDate()
  if (val && typeof val.toDate === 'function') return val.toDate().toISOString().slice(0, 10);
  // Firestore Timestamp com .seconds
  if (val && val.seconds) return new Date(val.seconds * 1000).toISOString().slice(0, 10);
  // Date nativo
  if (val instanceof Date && !isNaN(val)) return val.toISOString().slice(0, 10);
  return null;
}

function formatarData(val) {
  const iso = normalizarData(val);
  if (!iso) return null;
  return iso.split('-').reverse().join('/');
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
    if (!mapa[key]) mapa[key] = { cliente: key, tipo: item.tipo, produtos: [], docIds: [] };
    mapa[key].produtos.push(item);
    if (item.id) mapa[key].docIds.push(item.id);
  }
  return Object.values(mapa);
}

// ── componente principal ──────────────────────────────────

function normalizarNome(n) {
  return String(n || '').replace(/\s+[A-Z]{2}$/, '').trim();
}

export default function LinhaDoTempo({ vendedorNome, nivelAtual }) {
  const [itens, setItens]           = useState([]);
  const [contatos, setContatos]     = useState({});
  const [telefones, setTelefones]   = useState({});
  const [feitos, setFeitos]         = useState(new Set());
  const [expandidos, setExpandidos] = useState(new Set());
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro]             = useState(null);
  const [pedidosHoje, setPedidosHoje] = useState([]);

  // alertas
  const [alertasDiarios, setAlertasDiarios] = useState(null); // { alertas, prospectosLivres, clientesInativos }
  const [desistidas, setDesistidas]         = useState(new Set());
  const [agendamentosMap, setAgendamentosMap] = useState({}); // { empresa: 'YYYY-MM-DD' }
  const [modalAgendar, setModalAgendar]     = useState(null);
  const [modalDesistir, setModalDesistir]   = useState(null);
  const [dataAgend, setDataAgend]           = useState('');
  const [salvandoAcao, setSalvandoAcao]     = useState(false);
  const [mostrarPL, setMostrarPL]           = useState(false);
  const [mostrarCI, setMostrarCI]           = useState(false);
  const [alertasFeitos, setAlertasFeitos]   = useState(new Set());
  const [aba, setAba]                       = useState('hoje'); // 'hoje' | 'agenda'
  const [agendamentosList, setAgendamentosList] = useState([]); // lista completa p/ Agenda

  // modal de anotações
  const [modalAnotacoes,     setModalAnotacoes]     = useState(null);  // { empresa }
  const [anotacoesLista,     setAnotacoesLista]     = useState([]);
  const [carregandoAnotacoes,setCarregandoAnotacoes]= useState(false);

  // alertas de aniversário
  const [anivHoje,    setAnivHoje]    = useState([]); // compradores com aniversário hoje
  const [anivEm3Dias, setAnivEm3Dias] = useState([]); // aniversário em 3 dias

  // cache key compartilhado entre o useEffect e as funções de ação
  const slug     = vendedorNome ? vendedorNome.toLowerCase().replace(/\s+/g, '_') : '';
  const cacheKey = `p3_alertas_${slug}`;

  useEffect(() => {
    if (!vendedorNome) { setCarregando(false); return; }
    setCarregando(true);
    setErro(null);

    // Força busca no servidor (ignora cache offline do Firestore)
    getDocsFromServer(query(collection(db, 'pedidosDia'), where('vendedor', '==', vendedorNome)))
      .then(async (snap) => {
        const hoje = hojeISO();

        // Normaliza dataSugestao: aceita string ISO, Timestamp Firestore ou Date
        // IMPORTANTE: usa dataParaISO (getters locais) e NÃO toISOString() para
        // evitar bug de fuso: timestamps do final do dia em Brasília (UTC-3) têm
        // hora UTC do dia seguinte e seriam incorretamente mapeados para "amanhã".
        const normData = (v) => {
          if (!v) return '';
          if (typeof v === 'string') return v.slice(0, 10);
          const d = v.toDate ? v.toDate() : (v instanceof Date ? v : null);
          if (d) return dataParaISO(d); // usa hora local, igual a hojeISO()
          return String(v).slice(0, 10);
        };

        const todos = snap.docs.map((d) => ({ id: d.id, ...d.data(), _dataISO: normData(d.data().dataSugestao) }));

        // Deleta em background os docs de outros dias
        todos
          .filter((d) => d._dataISO !== hoje)
          .forEach((d) => deleteDoc(doc(db, 'pedidosDia', d.id)).catch(() => {}));

        // Exibe apenas os de hoje
        const lista = todos.filter((d) => d._dataISO === hoje);
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

  // ── busca alertas pré-calculados de alertas_diarios ─────
  useEffect(() => {
    if (!vendedorNome) return;

    const TTL_MS = 4 * 60 * 60 * 1000; // 4 horas

    function restaurarCache() {
      try {
        const raw = localStorage.getItem(cacheKey);
        if (!raw) return false;
        const obj = JSON.parse(raw);
        if (Date.now() - obj.ts > TTL_MS) return false;
        setAlertasDiarios(obj.alertasDiarios || null);
        setDesistidas(new Set(obj.desistidas || []));
        setAgendamentosMap(obj.agendamentosMap || {});
        setAgendamentosList(obj.agendamentosList || []);
        return true;
      } catch { return false; }
    }

    if (restaurarCache()) return;

    async function carregarAlertas() {
      try {
        const hoje = hojeISO();
        const docId = `${slug}_${hoje}`;

        // 3 queries em paralelo: 1 doc pré-calculado + 2 queries filtradas por vendedor
        const [snapAlerta, snapDes, snapAg] = await Promise.all([
          getDoc(doc(db, 'alertas_diarios', docId)),
          getDocs(query(collection(db, 'desistencias'), where('vendedor', '==', vendedorNome))),
          getDocs(query(collection(db, 'agendamentosVisita'), where('vendedor', '==', vendedorNome))),
        ]);

        // 1. Alertas pré-calculados
        const dadosAlerta = snapAlerta.exists()
          ? {
              alertas:          snapAlerta.data().alertas          || [],
              prospectosLivres: snapAlerta.data().prospectosLivres || [],
              clientesInativos: snapAlerta.data().clientesInativos || [],
            }
          : { alertas: [], prospectosLivres: [], clientesInativos: [] };

        // 2. Desistências deste vendedor
        const minhasDesistidas = snapDes.docs.map((d) => d.data().empresa).filter(Boolean);

        // 3. Agendamentos deste vendedor
        const agMap  = {};
        const agList = [];
        snapAg.docs.forEach((d) => {
          const a = d.data();
          if (!a.empresa || !a.dataAgendada) return;
          agList.push({ id: d.id, ...a });
          if (a.dataAgendada >= hoje) agMap[a.empresa] = a.dataAgendada;
        });
        agList.sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada));

        // Salva no cache (4h)
        try {
          localStorage.setItem(cacheKey, JSON.stringify({
            ts: Date.now(),
            alertasDiarios:  dadosAlerta,
            desistidas:      minhasDesistidas,
            agendamentosMap: agMap,
            agendamentosList: agList,
          }));
        } catch {}

        setAlertasDiarios(dadosAlerta);
        setDesistidas(new Set(minhasDesistidas));
        setAgendamentosMap(agMap);
        setAgendamentosList(agList);
      } catch (e) { console.error(e); }
    }
    carregarAlertas();
  }, [vendedorNome]);

  // ── busca telefones pelo CNPJ dos alertas ────────────────────
  useEffect(() => {
    const alertas = alertasDiarios?.alertas || [];
    const cnpjs = [...new Set(alertas.map((a) => a.cnpj).filter(Boolean))];
    if (!cnpjs.length) return;

    console.log('[WA] CNPJs dos alertas:', cnpjs.slice(0, 5));
    async function fetchTelefones() {
      const porCnpj = {}; // cnpj → telefone
      for (let i = 0; i < cnpjs.length; i += 30) {
        const lote = cnpjs.slice(i, i + 30);
        const q = query(collection(db, 'clientes'), where('cnpj', 'in', lote));
        const s = await getDocs(q);
        s.docs.forEach((d) => {
          const data = d.data();
          if (data.cnpj && data.telefone)
            porCnpj[data.cnpj] = String(data.telefone).replace(/\D/g, '');
        });
      }
      // Remonta mapa keyed por empresa (para uso no AlertCard via alerta.empresa)
      const mapa = {};
      alertas.forEach((a) => {
        if (a.cnpj && porCnpj[a.cnpj]) mapa[a.empresa] = porCnpj[a.cnpj];
      });
      console.log('[WA] porCnpj:', porCnpj);
      console.log('[WA] mapa final:', mapa);
      setTelefones(mapa);
    }
    fetchTelefones();
  }, [alertasDiarios]);

  // ── alertas de aniversário ───────────────────────────────
  useEffect(() => {
    if (!vendedorNome) return;
    getDocs(query(collection(db, 'aniversarios'), where('vendedor', '==', vendedorNome)))
      .then(snap => {
        const hoje  = new Date();
        const em3   = new Date(hoje); em3.setDate(em3.getDate() + 3);
        const fmt   = (d) => `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const hojeS = fmt(hoje);
        const em3S  = fmt(em3);
        const hoje_  = [], em3_ = [];
        snap.docs.forEach(d => {
          const r = d.data();
          if (!r.diaAniversario) return;
          if (r.diaAniversario === hojeS) hoje_.push(r);
          else if (r.diaAniversario === em3S) em3_.push(r);
        });
        setAnivHoje(hoje_);
        setAnivEm3Dias(em3_);
      }).catch(console.error);
  }, [vendedorNome]);

  // ── alertas computados (lidos direto de alertas_diarios) ─

  // Filtra desistências e agendamentos feitos na sessão atual
  const todosAlertas = (alertasDiarios?.alertas || [])
    .filter((a) => !desistidas.has(a.empresa) && !agendamentosMap[a.empresa]);

  const alertasVermelhos = todosAlertas.filter((a) => a.nivel === 'vermelho');
  const alertasAmarelos  = todosAlertas.filter((a) => a.nivel === 'amarelo');

  // Alertas com agendamento ativo (mostrados separados, mais discretos)
  const alertasAgendados = (alertasDiarios?.alertas || [])
    .filter((a) => !desistidas.has(a.empresa) && !!agendamentosMap[a.empresa]);

  // Listas de expirados derivadas do documento pré-calculado
  const prospectosLivres = (alertasDiarios?.prospectosLivres || [])
    .filter((p) => !desistidas.has(p.empresa));
  const clientesInativos = (alertasDiarios?.clientesInativos || [])
    .filter((p) => !desistidas.has(p.empresa));

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
      localStorage.removeItem(cacheKey); // invalida cache para refletir o novo agendamento
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
      localStorage.removeItem(cacheKey); // invalida cache para refletir a desistência
      setModalDesistir(null);
    } catch (e) { console.error(e); }
    finally { setSalvandoAcao(false); }
  }

  const grupos     = useMemo(() => agruparPorCliente(itens), [itens]);
  const pendentes  = useMemo(() => grupos.filter((g) => !feitos.has(g.cliente)), [grupos, feitos]);
  const concluidos = useMemo(() => grupos.filter((g) =>  feitos.has(g.cliente)), [grupos, feitos]);
  const pendentesAtivos = useMemo(() => pendentes.filter((g) => g.produtos.some((p) => !parouDeUsar(p))), [pendentes]);
  const morrendo        = useMemo(() => pendentes.filter((g) => g.produtos.every((p) =>  parouDeUsar(p))), [pendentes]);
  const primeiroNome    = useMemo(() => vendedorNome ? vendedorNome.split(' ')[0] : '', [vendedorNome]);
  const hoje            = hojeISO();
  const agendFuturos    = useMemo(() => agendamentosList.filter((a) => a.dataAgendada >= hoje).length, [agendamentosList, hoje]);
  const totalPendencias = todosAlertas.length + pendentesAtivos.length;

  const toggleFeito    = useCallback((c) => { setFeitos((p)    => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n; }); }, []);
  const toggleExpandir = useCallback((c) => { setExpandidos((p) => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n; }); }, []);

  function chaveAlerta(a)       { return `${a.empresa}__${a.subTipo}`; }
  function toggleAlertaFeito(a) {
    setAlertasFeitos((p) => { const n = new Set(p); const k = chaveAlerta(a); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  async function abrirAnotacoes(alerta) {
    setModalAnotacoes({ empresa: alerta.empresa });
    setAnotacoesLista([]);
    setCarregandoAnotacoes(true);
    try {
      const snap = await getDocs(query(
        collection(db, 'relatorioVisitas'),
        where(documentId(), '>=', slug + '_'),
        where(documentId(), '<',  slug + '_'),
      ));
      const lista = snap.docs
        .filter(d => {
          const r = d.data();
          return String(r.empresa || '').trim().toLowerCase() === alerta.empresa.trim().toLowerCase();
        })
        .map(d => {
          const r = d.data();
          // extrai data do docId (formato: slug_..._YYYY-MM-DD_HH-MM)
          const dateMatch = d.id.match(/(\d{4}-\d{2}-\d{2})/);
          const dataISO = dateMatch ? dateMatch[1] : '';
          const dataFmt = dataISO ? dataISO.split('-').reverse().join('/') : '';
          return {
            id: d.id,
            dataISO,
            dataFmt,
            anotacao: String(r.anotacoes || '').trim(),
            satisfacao: r.satisfacao != null ? Number(r.satisfacao) : null,
          };
        })
        .filter(a => a.anotacao)
        .sort((a, b) => b.dataISO.localeCompare(a.dataISO));
      setAnotacoesLista(lista);
    } catch (err) { console.error(err); }
    finally { setCarregandoAnotacoes(false); }
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
                telefone={telefones[a.empresa] || ''}
                onFeito={() => toggleAlertaFeito(a)}
                onInformar={() => window.open(FORM_VISITA_URL, '_blank')}
                onAgendar={() => { setModalAgendar(a); setDataAgend(''); }}
                onDesistir={() => setModalDesistir(a)}
                onVerAnotacoes={() => abrirAnotacoes(a)} />
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
          {nivelAtual != null && (
            <span style={{ ...s.pill, background: '#dbeafe', color: '#1d4ed8' }}>
              Nível {nivelAtual}
            </span>
          )}
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

      {/* ── Alertas de Aniversário ───────────────────────── */}
      {anivHoje.map(a => (
        <div key={a.cnpj} style={{ background: '#fef3c7', border: '2px solid #fbbf24', borderRadius: '12px', padding: '14px 16px', marginTop: '10px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <span style={{ fontSize: '28px', lineHeight: 1 }}>🎂</span>
          <div>
            <p style={{ margin: '0 0 2px', fontWeight: '800', color: '#92400e', fontSize: '14px' }}>Aniversário hoje!</p>
            <p style={{ margin: 0, fontSize: '13px', color: '#78350f' }}>
              O comprador de <strong>{a.cliente}</strong> faz aniversário hoje.
              Que tal mandar uma mensagem especial? 🥳
            </p>
          </div>
        </div>
      ))}
      {anivEm3Dias.map(a => (
        <div key={a.cnpj} style={{ background: '#ede9fe', border: '2px solid #a78bfa', borderRadius: '12px', padding: '14px 16px', marginTop: '10px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <span style={{ fontSize: '28px', lineHeight: 1 }}>🎁</span>
          <div>
            <p style={{ margin: '0 0 2px', fontWeight: '800', color: '#5b21b6', fontSize: '14px' }}>Aniversário em 3 dias!</p>
            <p style={{ margin: 0, fontSize: '13px', color: '#4c1d95' }}>
              O comprador de <strong>{a.cliente}</strong> faz aniversário em 3 dias ({a.diaAniversario.split('-').reverse().join('/')}).
              Pense em um presente ou mensagem! 🎁
            </p>
          </div>
        </div>
      ))}

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
              onToggle={toggleFeito} onExpandir={toggleExpandir}
            />
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
                {modalAgendar.subTipo === 'ambos'
                  ? `${modalAgendar.diasVisita}d sem visita · ${modalAgendar.diasPedido}d sem pedido`
                  : `${modalAgendar.dias}d sem ${modalAgendar.subTipo === 'pedido' ? 'pedido' : 'visita'}`}
              </span>
            </p>

            <p style={sa.label}>Data da visita</p>
            <input type="date"
              value={dataAgend}
              min={hojeISO()}
              max={modalAgendar.tipo !== 'pedido'
                ? maxDataAgend(modalAgendar.lastDateVisita || modalAgendar.lastDate, modalAgendar.tipo, modalAgendar.nivel)
                : undefined}
              onChange={(e) => setDataAgend(e.target.value)}
              style={{ ...sa.input, marginBottom: '6px' }}
            />
            {modalAgendar.tipo !== 'pedido' && (
              <p style={{ margin: '0 0 18px', fontSize: '11px', color: '#9ca3af' }}>
                Prazo máximo: {maxDataAgend(modalAgendar.lastDateVisita || modalAgendar.lastDate, modalAgendar.tipo, modalAgendar.nivel).split('-').reverse().join('/')}
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

      {/* ── Modal: Anotações ──────────────────────────────── */}
      {modalAnotacoes && (
        <div style={sa.overlay} onClick={() => setModalAnotacoes(null)}>
          <div style={{ ...sa.modal, maxWidth: '520px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: '0 0 2px', fontSize: '17px', fontWeight: '800' }}>✏️ Anotações de Visita</h3>
                <p style={{ margin: 0, color: '#6b7280', fontSize: '13px' }}>{modalAnotacoes.empresa}</p>
              </div>
              <button onClick={() => setModalAnotacoes(null)}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#9ca3af', lineHeight: 1 }}>
                ×
              </button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1 }}>
              {carregandoAnotacoes ? (
                <p style={{ textAlign: 'center', color: '#9ca3af', padding: '32px 0' }}>Carregando anotações...</p>
              ) : anotacoesLista.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ fontSize: '32px', margin: '0 0 8px' }}>📋</p>
                  <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0 }}>Nenhuma anotação registrada para este cliente.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {anotacoesLista.map(a => (
                    <div key={a.id} style={{ background: '#f9fafb', borderRadius: '10px', padding: '12px 14px', borderLeft: '3px solid #6366f1' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ fontSize: '12px', fontWeight: '700', color: '#374151' }}>
                          {a.dataFmt || '—'}
                        </span>
                        {a.satisfacao != null && !isNaN(a.satisfacao) && (
                          <span style={{
                            fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '20px',
                            background: a.satisfacao >= 7 ? '#dcfce7' : a.satisfacao >= 5 ? '#fef3c7' : '#fee2e2',
                            color:      a.satisfacao >= 7 ? '#15803d' : a.satisfacao >= 5 ? '#92400e' : '#b91c1c',
                          }}>
                            Satisfação: {a.satisfacao}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontSize: '13px', color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {a.anotacao}
                      </p>
                    </div>
                  ))}
                </div>
              )}
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

function AlertCard({ alerta, agendado, feito, telefone = '', onFeito, onInformar, onAgendar, onDesistir, onVerAnotacoes }) {
  const isVermelho  = alerta.nivel === 'vermelho';
  const isProspecto = alerta.tipo === 'prospecto';
  const isPedido    = alerta.subTipo === 'pedido';
  const isAmbos     = alerta.subTipo === 'ambos';
  const escuro      = !!alerta.escuro;

  const nivCor  = isVermelho  ? '#dc2626' : '#d97706';
  const tipoCor = isProspecto ? '#7c3aed' : '#2563eb';
  const tipoBg  = isProspecto ? '#ede9fe' : '#dbeafe';

  // Borda e fundo mais intensos quando o card é "escuro" (visita + pedido juntos)
  const bordaCor = feito ? '#d1d5db'
    : escuro ? (isVermelho ? '#991b1b' : '#92400e')
    : nivCor;
  const bgCard   = feito ? '#f9fafb'
    : escuro ? (isVermelho ? '#fff1f2' : '#fffbeb')
    : '#fff';

  // Aviso de expiração próxima (≤ 7 dias), usa diasParaExpirar pré-calculado
  const restam = (alerta.diasParaExpirar != null && !isPedido) ? alerta.diasParaExpirar : null;

  return (
    <div style={{
      background: bgCard,
      borderRadius: '10px',
      border: `1px solid ${escuro && !feito ? bordaCor + '55' : '#e5e7eb'}`,
      borderTop: `3px solid ${bordaCor}`,
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

        {/* Badge(s) de dias — duplo quando subTipo === 'ambos' */}
        {isAmbos ? (
          <>
            <span style={{
              alignSelf: 'flex-start', fontSize: '10px', fontWeight: '700',
              padding: '1px 6px', borderRadius: '20px',
              background: feito ? '#f3f4f6' : (isVermelho ? '#fee2e2' : '#fef3c7'),
              color: feito ? '#9ca3af' : nivCor,
            }}>
              {alerta.diasVisita}d sem visita
            </span>
            <span style={{
              alignSelf: 'flex-start', fontSize: '10px', fontWeight: '700',
              padding: '1px 6px', borderRadius: '20px',
              background: feito ? '#f3f4f6' : (isVermelho ? '#fee2e2' : '#fef3c7'),
              color: feito ? '#9ca3af' : nivCor,
            }}>
              {alerta.diasPedido}d sem pedido
            </span>
          </>
        ) : (
          <span style={{
            alignSelf: 'flex-start', fontSize: '10px', fontWeight: '700',
            padding: '1px 6px', borderRadius: '20px',
            background: feito ? '#f3f4f6' : (isVermelho ? '#fee2e2' : '#fef3c7'),
            color: feito ? '#9ca3af' : nivCor,
          }}>
            {alerta.dias}d {isPedido ? 'sem pedido' : 'sem visita'}
          </span>
        )}

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
          {telefone && (() => {
            const hora = new Date().getHours();
            const saud = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
            const fone = telefone.startsWith('55') ? telefone : `55${telefone}`;
            const msg  = encodeURIComponent(
              `${saud}, ${alerta.empresa}, tudo bem? Que dia eu posso passar pra te fazer uma visita essa semana?`
            );
            return (
              <a href={`https://wa.me/${fone}?text=${msg}`} target="_blank" rel="noopener noreferrer"
                title="Enviar mensagem no WhatsApp"
                style={{ ...sa.iconBtn, color: '#25d366', textDecoration: 'none' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </a>
            );
          })()}
          {onVerAnotacoes && (
            <button onClick={onVerAnotacoes} title="Ver anotações de visita" style={sa.iconBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          )}
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

const ClienteCard = memo(function ClienteCard({ grupo, feito, expandido, contato, vendedor, onToggle, onExpandir }) {
  const tipo        = resolverTipo(grupo.tipo);
  const ativos      = grupo.produtos.filter((p) => !parouDeUsar(p));
  const parados     = grupo.produtos.filter((p) =>  parouDeUsar(p));
  const tGlobal     = tendenciaGlobal(ativos);

  // Data da última compra do cliente (mais recente entre todos os produtos)
  const ultimaCompraISO = grupo.produtos
    .map((p) => normalizarData(p.ultimaCompra))
    .filter(Boolean)
    .sort()
    .reverse()[0] || null;
  const ultimaCompraFmt  = ultimaCompraISO ? ultimaCompraISO.split('-').reverse().join('/') : null;
  const diasUltimaCompra = ultimaCompraISO ? diasDesde(ultimaCompraISO) : null;
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
            {ultimaCompraFmt && (
              <span style={{
                marginLeft: '6px',
                fontSize: '11px', fontWeight: '600',
                color: diasUltimaCompra >= 60 ? '#dc2626' : diasUltimaCompra >= 30 ? '#d97706' : '#16a34a',
                background: diasUltimaCompra >= 60 ? '#fee2e2' : diasUltimaCompra >= 30 ? '#fef3c7' : '#dcfce7',
                padding: '1px 7px', borderRadius: '20px',
              }}>
                🛒 {ultimaCompraFmt} ({diasUltimaCompra}d)
              </span>
            )}
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
});

// ── produto ativo ─────────────────────────────────────────

const ProdutoAtivo = memo(function ProdutoAtivo({ p, zebra, ultimo }) {
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
});

// ── produto parado (com checkbox + última compra) ─────────

const ProdutoParado = memo(function ProdutoParado({ p, zebra, ultimo, selecionado, onToggle }) {
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
});

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

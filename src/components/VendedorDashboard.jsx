import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import MetaCard from './MetaCard';
import GraficoVendasMensais from './GraficoVendasMensais';
import LinhaDoTempo from './LinhaDoTempo';

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// Tabela de Níveis Comerciais — lista fixa, ordenada do mais fácil ao mais difícil
// Colunas: comissaoMinima e inadimplenciaMax em % | fatPorClienteMin em R$ | adicionalComissao em %
const NIVEIS_COMERCIAIS = [
  { nivel: '1',  comissaoMinima: 0, inadimplenciaMax: 100, clientesAtivosMin: 10,  fatPorClienteMin: 0,    adicionalComissao: 0  },
  { nivel: '1+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 10,  fatPorClienteMin: 700,  adicionalComissao: 0  },
  { nivel: '2',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 25,  fatPorClienteMin: 700,  adicionalComissao: 0  },
  { nivel: '2+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 25,  fatPorClienteMin: 1200, adicionalComissao: 2  },
  { nivel: '3',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 50,  fatPorClienteMin: 1200, adicionalComissao: 5  },
  { nivel: '4',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 75,  fatPorClienteMin: 1200, adicionalComissao: 5  },
  { nivel: '4+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 75,  fatPorClienteMin: 1700, adicionalComissao: 10 },
  { nivel: '5',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 90,  fatPorClienteMin: 1700, adicionalComissao: 10 },
  { nivel: '6',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 110, fatPorClienteMin: 1700, adicionalComissao: 10 },
  { nivel: '6+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 110, fatPorClienteMin: 1900, adicionalComissao: 15 },
  { nivel: '7',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 130, fatPorClienteMin: 1900, adicionalComissao: 15 },
  { nivel: '7+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 130, fatPorClienteMin: 2200, adicionalComissao: 20 },
  { nivel: '8',  comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 150, fatPorClienteMin: 2200, adicionalComissao: 20 },
  { nivel: '8+', comissaoMinima: 3, inadimplenciaMax: 3,   clientesAtivosMin: 150, fatPorClienteMin: 2700, adicionalComissao: 25 },
];

// Limites únicos extraídos de NIVEIS_COMERCIAIS para cada critério
const LIMITES_COMISSAO = [...new Set(NIVEIS_COMERCIAIS.map(n => n.comissaoMinima).filter(v => v > 0))].sort((a, b) => a - b);
const LIMITES_INADIML  = [...new Set(NIVEIS_COMERCIAIS.map(n => n.inadimplenciaMax).filter(v => v < 100))].sort((a, b) => a - b);
const LIMITES_CLIENTES = [...new Set(NIVEIS_COMERCIAIS.map(n => n.clientesAtivosMin).filter(v => v > 0))].sort((a, b) => a - b);
const LIMITES_FAT_CLI  = [...new Set(NIVEIS_COMERCIAIS.map(n => n.fatPorClienteMin).filter(v => v > 0))].sort((a, b) => a - b);

function moeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function percent(valor) {
  return `${Number(valor || 0).toFixed(1)}%`;
}

function compacto(v) {
  if (v >= 1000) return `${(v / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  return String(Math.round(v));
}

// Retorna a data de 30 dias corridos atrás (yyyy-mm-dd)
function ultimos30dias() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

// Chave de cache = data da segunda-feira desta semana
// Garante que os dados só mudam na segunda-feira seguinte
function chaveSemana() {
  const d   = new Date();
  const dow = d.getDay(); // 0=Dom, 1=Seg…
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

function lerCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj.semana === chaveSemana() ? obj.data : null;
  } catch { return null; }
}

function salvarCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ semana: chaveSemana(), data }));
  } catch {}
}

// Cache diário — expira a cada dia (para dados que atualizam todo dia)
function lerCacheDiario(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj.dia === new Date().toISOString().slice(0, 10) ? obj.data : null;
  } catch { return null; }
}

function salvarCacheDiario(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ dia: new Date().toISOString().slice(0, 10), data }));
  } catch {}
}

function formatarData(data) {
  if (!data) return '—';
  if (data?.toDate) return data.toDate().toLocaleDateString('pt-BR');
  if (typeof data === 'string') return data.slice(0, 10).split('-').reverse().join('/');
  return String(data);
}

function extrairNumeroVenda(chave) {
  if (!chave) return null;
  const partes = chave.split('_');
  return partes.length >= 2 ? partes[1] : null;
}

function finId(p) {
  const nv = extrairNumeroVenda(p.chave);
  return nv && p.contaAzul ? `${p.contaAzul}_${nv}` : null;
}

function normalizarCnpj(cnpj) {
  if (!cnpj) return null;
  return String(typeof cnpj === 'number' ? Math.round(cnpj) : cnpj).replace(/\D/g, '');
}

async function buscarClientes(cnpjs) {
  if (!cnpjs.length) return {};
  const mapa = {};
  for (let i = 0; i < cnpjs.length; i += 30) {
    const lote = cnpjs.slice(i, i + 30);
    const q = query(collection(db, 'clientes'), where('cnpj', 'in', lote));
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      const data = d.data();
      mapa[data.cnpj] = {
        status:          data.status          || '',
        statusBloqueio:  data.statusBloqueio  || '',
        orientacaoVenda: data.orientacaoVenda || '',
        score:           data.score           || '',
      };
    });
  }
  return mapa;
}

function corStatus(status) {
  const map = {
    'Excelente':     { cor: '#16a34a', bg: '#dcfce7' },
    'Bom':           { cor: '#2563eb', bg: '#dbeafe' },
    'Regular':       { cor: '#d97706', bg: '#fef3c7' },
    'Ruim':          { cor: '#ea580c', bg: '#ffedd5' },
    'Crítico':       { cor: '#dc2626', bg: '#fee2e2' },
    'Sem Histórico': { cor: '#6b7280', bg: '#f3f4f6' },
  };
  return map[status] || { cor: '#6b7280', bg: '#f3f4f6' };
}

async function buscarFinanceiro(pedidos) {
  if (!pedidos.length) return {};
  const mapa = {};
  const ids = [...new Set(pedidos.map(finId).filter(Boolean))];
  if (!ids.length) return {};
  for (let i = 0; i < ids.length; i += 30) {
    const lote = ids.slice(i, i + 30);
    const q = query(collection(db, 'financeiro'), where('docId', 'in', lote));
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      const data = d.data();
      const boletos = Array.isArray(data.boletos) ? data.boletos : [];
      const maxDias = boletos.reduce((mx, b) => Math.max(mx, Number(b.diasAtraso || 0)), 0);
      mapa[data.docId] = { statusGeral: data.statusGeral || 'EM_ABERTO', diasAtraso: maxDias };
    });
  }
  return mapa;
}

function agruparPorVenda(pedidos, financeiro, clientes) {
  const grupos = {};
  for (const p of pedidos) {
    const id = finId(p) || `avulso_${p.id}`;
    if (!grupos[id]) {
      const fin = financeiro[id] || {};
      grupos[id] = {
        id,
        contaAzul:        p.contaAzul || '',
        numeroVenda:      extrairNumeroVenda(p.chave) || '',
        cliente:          p.cliente || '—',
        dataVenda:        p.dataVenda || '',
        estado:           p.estado || '',
        situacao:         p.situacao || '',
        status:           fin.statusGeral || null,
        diasAtraso:       fin.diasAtraso  || 0,
        statusFinanceiro: '',
        orientacaoVenda:  '',
        score:            '',
        pedidos:          [],
        totalFat:         0,
        totalCom:         0,
      };
    }
    // Usa o primeiro CNPJ válido encontrado no grupo (ignora linhas de frete sem CNPJ)
    if (!grupos[id].statusFinanceiro && p.cnpj) {
      const cnpj = normalizarCnpj(p.cnpj);
      const cli  = (cnpj && clientes[cnpj]) || {};
      if (cli.status) {
        grupos[id].statusFinanceiro = cli.status          || '';
        grupos[id].orientacaoVenda  = cli.orientacaoVenda || '';
        grupos[id].score            = cli.score           || '';
      }
    }
    grupos[id].pedidos.push(p);
    grupos[id].totalFat += Number(p.faturamento || 0);
    grupos[id].totalCom += Number(p.comissao    || 0);
  }
  return Object.values(grupos).sort((a, b) => (b.dataVenda || '').localeCompare(a.dataVenda || ''));
}

function corComissao(status) {
  if (status === 'RECEBIDO') return '#16a34a';
  if (status === 'ATRASADO') return '#dc2626';
  return '#9ca3af';
}

function labelStatus(status) {
  if (status === 'RECEBIDO')  return { texto: '● Pago',      cor: '#16a34a', bg: '#dcfce7' };
  if (status === 'ATRASADO')  return { texto: '● Atrasado',  cor: '#dc2626', bg: '#fee2e2' };
  if (status === 'PERDIDO')   return { texto: '● Perdido',   cor: '#6b7280', bg: '#f3f4f6' };
  return                             { texto: '● Em aberto', cor: '#9ca3af', bg: '#f3f4f6' };
}

// Remove sufixo de estado do nome (ex: "Diogo MG" → "Diogo")
function normalizarVendedor(nome) {
  return String(nome || '').replace(/\s+[A-Z]{2}$/, '').trim();
}

function proximaSegunda() {
  const d = new Date();
  const diff = (1 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
}

// ── Componentes da aba Clientes ───────────────────────────────────────────

function estaBloqueado(statusBloqueio) {
  return String(statusBloqueio || '').toLowerCase().includes('bloqueado');
}

function ClienteCard({ cliente }) {
  const { cor, bg } = corStatus(cliente.status || 'Sem Histórico');
  const bloqueado = estaBloqueado(cliente.statusBloqueio);
  return (
    <div style={{
      background: '#fff', borderRadius: '10px', padding: '14px 16px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
      borderLeft: bloqueado ? '4px solid #dc2626' : `4px solid ${cor}`,
      display: 'flex', flexDirection: 'column', gap: '5px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: '700', fontSize: '14px', color: '#111827' }}>{cliente.nome}</span>
        {cliente.cidade && <span style={{ fontSize: '11px', color: '#9ca3af' }}>{cliente.cidade}</span>}
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        {cliente.status && (
          <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '20px', fontWeight: '600', color: cor, background: bg }}>
            ★ {cliente.status}
          </span>
        )}
        {bloqueado && (
          <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '20px', fontWeight: '600', color: '#dc2626', background: '#fee2e2' }}>
            🔒 {cliente.statusBloqueio}
          </span>
        )}
        {cliente.score && (
          <span style={{ fontSize: '11px', color: '#9ca3af' }}>Score: {cliente.score}</span>
        )}
      </div>
      {cliente.orientacaoVenda && (
        <p style={{ margin: 0, fontSize: '12px', color: '#6b7280', fontStyle: 'italic' }}>{cliente.orientacaoVenda}</p>
      )}
      {cliente.cnpj && (
        <span style={{ fontSize: '11px', color: '#d1d5db' }}>CNPJ: {cliente.cnpj}</span>
      )}
    </div>
  );
}

function GrupoClientes({ titulo, cor, lista, defaultAberto }) {
  const [aberto, setAberto] = useState(defaultAberto || false);
  if (!lista.length) return null;
  return (
    <div style={{ marginBottom: '10px' }}>
      <button
        onClick={() => setAberto((a) => !a)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: '#fff', border: '1.5px solid #e5e7eb',
          borderRadius: aberto ? '10px 10px 0 0' : '10px',
          padding: '11px 16px', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{ fontWeight: '700', fontSize: '14px', color: cor || '#374151' }}>{titulo}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ background: cor || '#6b7280', color: '#fff', borderRadius: '20px', padding: '1px 9px', fontSize: '12px', fontWeight: '700' }}>
            {lista.length}
          </span>
          <span style={{ color: '#9ca3af', fontSize: '12px' }}>{aberto ? '▲' : '▼'}</span>
        </div>
      </button>
      {aberto && (
        <div style={{ border: '1.5px solid #e5e7eb', borderTop: 'none', borderRadius: '0 0 10px 10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', background: '#f8fafc' }}>
          {lista.map((c) => <ClienteCard key={c.cnpj || c.nome} cliente={c} />)}
        </div>
      )}
    </div>
  );
}

// ── Nível Comercial ───────────────────────────────────────────────────────────

function CriterioRow({ label, atual, minimo, maximo, formatar, invertido }) {
  const passou = maximo != null ? atual <= maximo : atual >= minimo;
  const refVal = maximo != null ? maximo : minimo;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '14px' }}>{passou ? '✅' : '❌'}</span>
        <span style={{ fontSize: '13px', color: '#374151' }}>{label}</span>
      </div>
      <div style={{ textAlign: 'right' }}>
        <span style={{ fontSize: '13px', fontWeight: '700', color: passou ? '#16a34a' : '#dc2626' }}>
          {formatar(atual)}
        </span>
        <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: '6px' }}>
          {maximo != null ? `máx. ${formatar(refVal)}` : `mín. ${formatar(refVal)}`}
        </span>
      </div>
    </div>
  );
}

// ── Pódio por critério ───────────────────────────────────────────────────────

function RankingNiveis({ metricasVendedores, vendedorAtual }) {
  const nomeNorm = vendedorAtual ? normalizarVendedor(vendedorAtual) : '';

  // Exclui vendedores com menos de R$20.000 de faturamento no período
  const dados = metricasVendedores.filter(m => {
    const fat = Number(m.totalFat) || (Number(m.fatPorCliente || 0) * Number(m.clientesAtivos || 0));
    return fat >= 20000;
  });

  const CRITERIOS = [
    { icone: '💰', label: 'Comissão',      campoM: 'comissaoPercent',      campoN: 'comissaoMinima',    tipo: 'min', fmt: v => `${v.toFixed(1)}%`              },
    { icone: '📉', label: 'Inadimplência', campoM: 'inadimplenciaPercent', campoN: 'inadimplenciaMax',  tipo: 'max', fmt: v => `${v.toFixed(1)}%`              },
    { icone: '🏢', label: 'Clientes',      campoM: 'clientesAtivos',       campoN: 'clientesAtivosMin', tipo: 'min', fmt: v => `${Math.round(v)}`             },
    { icone: '📈', label: 'Fat/cliente',   campoM: 'fatPorCliente',        campoN: 'fatPorClienteMin',  tipo: 'min', fmt: v => `R$${compacto(Math.round(v))}` },
  ];

  function nivelIdx(m, c) {
    const val = Number(m[c.campoM] || 0);
    let idx = -1;
    NIVEIS_COMERCIAIS.forEach((n, i) => {
      if (c.tipo === 'min' ? val >= n[c.campoN] : val <= n[c.campoN]) idx = i;
    });
    return idx;
  }

  // Estilos de cada degrau (0=ouro, 1=prata, 2=bronze)
  const STEP = [
    { h: 52, bg: 'linear-gradient(170deg,#fef9c3 0%,#fbbf24 100%)', border: '#f59e0b', shadow: '#fbbf2440', medal: '🥇', sz: '18px' },
    { h: 38, bg: 'linear-gradient(170deg,#f1f5f9 0%,#94a3b8 100%)', border: '#94a3b8', shadow: '#94a3b840', medal: '🥈', sz: '15px' },
    { h: 26, bg: 'linear-gradient(170deg,#fde68a 0%,#b45309 100%)', border: '#b45309', shadow: '#b4530940', medal: '🥉', sz: '13px' },
  ];

  // Ordem de exibição: 2° esquerda · 1° centro · 3° direita
  const DISPLAY_RANKS = [1, 0, 2];

  return (
    <div style={{ background: '#fff', borderRadius: '12px', padding: '16px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginBottom: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '14px' }}>
        <p style={{ margin: 0, fontSize: '11px', fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          🏆 Ranking · últimos 30 dias
        </p>
        <span style={{ fontSize: '10px', color: '#9ca3af' }}>
          📅 Atualiza toda segunda · próx. {proximaSegunda()}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '18px 14px' }}>
        {CRITERIOS.map(c => {
          const sorted = [...dados]
            .map(m => ({ nome: m.vendedor, idx: nivelIdx(m, c), val: Number(m[c.campoM] || 0) }))
            .sort((a, b) => c.tipo === 'max' ? a.val - b.val : b.val - a.val);

          // Agrupa apenas quando o valor real for igual (empate verdadeiro)
          const rv = v => Math.round(v * 10) / 10; // arredonda 1 casa para comparar
          const groups = [];
          for (const item of sorted) {
            if (!groups.length || rv(item.val) !== rv(groups[groups.length - 1][0].val)) {
              groups.push([item]);
            } else {
              groups[groups.length - 1].push(item);
            }
          }
          // groups[0]=1°, groups[1]=2°, groups[2]=3°

          const myGroup = groups.findIndex(g => g.some(s => normalizarVendedor(s.nome) === nomeNorm));
          const inTop3  = myGroup >= 0 && myGroup <= 2;

          return (
            <div key={c.campoM}>
              {/* Título */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '10px' }}>
                <span style={{ fontSize: '12px' }}>{c.icone}</span>
                <span style={{ fontSize: '10px', fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{c.label}</span>
              </div>

              {/* Pódio */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px' }}>
                {DISPLAY_RANKS.map((rank, pi) => {
                  const st      = STEP[rank];
                  const group   = groups[rank];          // pode ser undefined
                  const isMeHere = group?.some(s => normalizarVendedor(s.nome) === nomeNorm);
                  const nivel   = group?.[0]?.idx >= 0 ? NIVEIS_COMERCIAIS[group[0].idx].nivel : null;
                  const names   = group?.map(s => ({
                    first: normalizarVendedor(s.nome).split(' ')[0],
                    isMe:  normalizarVendedor(s.nome) === nomeNorm,
                    val:   s.val,
                  })) ?? [];

                  // Cor sempre fixa pelo rank (ouro/prata/bronze); usuário logado ganha borda azul
                  const border = isMeHere ? '#2563eb' : st.border;
                  const bg     = st.bg;

                  return (
                    <div key={pi} style={{ flex: rank === 0 ? 1.1 : 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                      {group ? (
                        <>
                          {/* Nomes + valores lado a lado */}
                          <div style={{ display: 'flex', gap: '1px', marginBottom: '2px' }}>
                            {names.slice(0, 3).map((n, i) => (
                              <div key={i} style={{ flex: 1, textAlign: 'center', overflow: 'hidden' }}>
                                <div style={{
                                  fontSize: '9px', lineHeight: 1.3,
                                  fontWeight: n.isMe ? '700' : '500',
                                  color: n.isMe ? '#1d4ed8' : '#374151',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {n.first}{n.isMe ? ' 👤' : ''}
                                </div>
                                <div style={{
                                  fontSize: '8px', lineHeight: 1.2,
                                  color: n.isMe ? '#3b82f6' : '#9ca3af',
                                  fontWeight: '500',
                                }}>
                                  {c.fmt(n.val)}
                                </div>
                              </div>
                            ))}
                            {names.length > 3 && (
                              <div style={{ flex: 1, textAlign: 'center', fontSize: '9px', color: '#9ca3af' }}>+{names.length - 3}</div>
                            )}
                          </div>

                          {/* Nível (único por degrau) */}
                          <div style={{ textAlign: 'center', fontSize: '10px', fontWeight: '800', color: isMeHere ? '#1d4ed8' : '#0f3460', marginBottom: '4px', lineHeight: 1 }}>
                            {nivel != null ? `Nv ${nivel}` : '—'}
                          </div>

                          {/* Degrau */}
                          <div style={{
                            width: '100%', height: `${st.h}px`,
                            background: bg,
                            border: `2px solid ${border}`,
                            borderRadius: '4px 4px 0 0',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: st.sz,
                            boxShadow: `inset 0 2px 6px rgba(255,255,255,0.45), 0 -1px 4px ${st.shadow}`,
                          }}>
                            {st.medal}
                          </div>
                        </>
                      ) : (
                        /* Degrau vazio */
                        <div style={{
                          width: '100%', height: `${st.h}px`,
                          background: '#f9fafb',
                          border: '1.5px dashed #e5e7eb',
                          borderRadius: '4px 4px 0 0',
                        }} />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Base */}
              <div style={{ height: '4px', background: 'linear-gradient(90deg,#e2e8f0,#cbd5e1,#e2e8f0)', borderRadius: '0 0 3px 3px', marginBottom: '6px' }} />

              {/* Minha posição se fora do pódio */}
              {!inTop3 && myGroup >= 0 && (() => {
                const me    = groups[myGroup].find(s => normalizarVendedor(s.nome) === nomeNorm) || groups[myGroup][0];
                const nivel = me.idx >= 0 ? NIVEIS_COMERCIAIS[me.idx].nivel : null;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#eff6ff', borderRadius: '5px', padding: '4px 8px' }}>
                    <span style={{ fontSize: '10px', color: '#1d4ed8', fontWeight: '700' }}>
                      {myGroup + 1}° {normalizarVendedor(me.nome).split(' ')[0]} 👤
                    </span>
                    <span style={{ fontSize: '11px', fontWeight: '800', color: '#1d4ed8' }}>
                      {nivel ? `Nv ${nivel}` : '—'}
                    </span>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function VendedorDashboard({ vendedorNome, mesInicial, anoInicial, onVoltar }) {
  const { perfil, logout } = useAuth();
  const nome        = vendedorNome || perfil?.vendedor; // nome completo — usado nas queries
  const nomeDisplay = normalizarVendedor(nome);          // sem estado — usado na exibição

  const hoje = new Date();
  const [mes, setMes]                   = useState(mesInicial || hoje.getMonth() + 1);
  const [ano, setAno]                   = useState(anoInicial || hoje.getFullYear());
  const [pedidos, setPedidos]           = useState([]);
  const [financeiro, setFinanceiro]     = useState({});
  const [clientes, setClientes]         = useState({});
  const [carregando, setCarregando]     = useState(false);
  const [filtroAtrasado, setFiltroAtrasado] = useState(false);
  const [expandidos, setExpandidos]     = useState(new Set());
  const [aba, setAba]                   = useState('meta');
  const [totalPago, setTotalPago]       = useState(0);
  const [todosClientes, setTodosClientes]           = useState([]);
  const [carregandoClientes, setCarregandoClientes] = useState(false);
  const [erroClientes, setErroClientes]             = useState(null);
  const [novosClientes30d, setNovosClientes30d]     = useState(0);
  const [metricasNivel, setMetricasNivel]           = useState(null);
  const [metricasVendedores, setMetricasVendedores] = useState(null);
  const [lideres, setLideres]                       = useState(null); // líderes por produto
  const [clientesDoMes, setClientesDoMes]           = useState(0);
  const [pedidosResp, setPedidosResp]               = useState([]); // pedidos do mês via vendedorResponsavel
  const [pedidosJanela, setPedidosJanela]           = useState([]); // pedidos na janela [mês-30d, fimMês] para progressão
  const [pedidosRespJanela, setPedidosRespJanela]   = useState([]); // idem via vendedorResponsavel
  const [financeiroJanela, setFinanceiroJanela]     = useState({}); // financeiro da janela
  const [progressaoNivel, setProgressaoNivel]       = useState(null); // { diasPorNivel, nivelMaioria, totalDias }
  const [nivelExpanded, setNivelExpanded]           = useState(false);

  const anos = [];
  for (let a = hoje.getFullYear(); a >= hoje.getFullYear() - 3; a--) anos.push(a);

  // REGRA: análises de carteira usam pedidos.vendedorResponsavel (responsável atual)
  // Comissões continuam usando pedidos.vendedor (histórico da venda)
  useEffect(() => {
    if (!nome) return;
    setErroClientes(null);
    async function buscarClientesDoVendedor() {
      setCarregandoClientes(true);
      try {
        // 1. Pedidos onde este vendedor é o responsável atual
        const snapPed = await getDocs(
          query(collection(db, 'pedidos'), where('vendedorResponsavel', '==', nome))
        );

        const limite24m = new Date();
        limite24m.setMonth(limite24m.getMonth() - 24);
        const limiteStr = limite24m.toISOString().slice(0, 10);

        const cnpjMap = {}; // cnpj → { nomeCliente, dt, firstDt, pontuacao }
        snapPed.docs.forEach((d) => {
          const p = d.data();
          const cnpj = normalizarCnpj(p.cnpj);
          if (!cnpj) return;
          const dv = p.dataVenda || '';
          if (!cnpjMap[cnpj]) cnpjMap[cnpj] = { nomeCliente: p.cliente || '—', dt: '', firstDt: dv, pontuacao: 0 };
          // data mais recente
          if (dv > cnpjMap[cnpj].dt) {
            cnpjMap[cnpj].dt = dv;
            cnpjMap[cnpj].nomeCliente = p.cliente || cnpjMap[cnpj].nomeCliente;
          }
          // data mais antiga (primeiro pedido)
          if (dv && (!cnpjMap[cnpj].firstDt || dv < cnpjMap[cnpj].firstDt)) {
            cnpjMap[cnpj].firstDt = dv;
          }
          // Soma pontuação apenas dos últimos 24 meses
          if (dv >= limiteStr) {
            cnpjMap[cnpj].pontuacao += Number(p.pontuacao || 0);
          }
        });

        // Clientes cujo primeiro pedido foi nos últimos 30 dias
        const limite30d = new Date();
        limite30d.setDate(limite30d.getDate() - 30);
        const limite30dStr = limite30d.toISOString().slice(0, 10);
        const novos30d = Object.values(cnpjMap).filter((c) => c.firstDt >= limite30dStr).length;
        setNovosClientes30d(novos30d);

        const cnpjs = Object.keys(cnpjMap);

        if (!cnpjs.length) {
          setErroClientes(`Nenhum cliente encontrado para "${nome}" em pedidos.vendedorResponsavel.`);
          setTodosClientes([]);
          return;
        }

        // 2. Lookup em clientes por CNPJ (lotes de 30)
        const cliMap = {};
        for (let i = 0; i < cnpjs.length; i += 30) {
          const lote = cnpjs.slice(i, i + 30);
          const snap = await getDocs(
            query(collection(db, 'clientes'), where('cnpj', 'in', lote))
          );
          snap.docs.forEach((d) => { const r = d.data(); cliMap[r.cnpj] = r; });
        }

        // 3. Monta lista
        const lista = cnpjs.map((cnpj) => {
          const r = cliMap[cnpj] || {};
          return {
            nome:            String(r.nomeEmpresa || r.cliente || cnpjMap[cnpj].nomeCliente || '—').trim(),
            cnpj,
            cidade:          String(r.cidade          || '').trim(),
            status:          String(r.status          || '').trim() || 'Sem Histórico',
            statusBloqueio:  String(r.statusBloqueio  || '').trim(),
            orientacaoVenda: String(r.orientacaoVenda || '').trim(),
            score:           r.score             != null ? Number(r.score)             : null,
            fatMedioMensal:  r.fatMedioMensal90d != null ? Number(r.fatMedioMensal90d) : 0,
            pontuacao:       cnpjMap[cnpj]?.pontuacao || 0,
          };
        }).sort((a, b) => a.nome.localeCompare(b.nome));

        setTodosClientes(lista);
      } catch (err) {
        console.error(err);
        setErroClientes(`Erro: ${err.message}`);
      } finally {
        setCarregandoClientes(false);
      }
    }
    buscarClientesDoVendedor();
  }, [nome]);

  // Métricas dos últimos 30 dias corridos — cache semanal (atualiza toda segunda-feira)
  useEffect(() => {
    if (!nome) return;

    const cacheKey = 'p3_nivel_' + nome.toLowerCase().replace(/\s+/g, '_');
    const cached   = lerCacheDiario(cacheKey);
    if (cached) { setMetricasNivel(cached); return; }

    const dataInicio = ultimos30dias();
    const dataFim    = new Date().toISOString().slice(0, 10);

    async function buscarMetricasNivel() {
      try {
        // Fat/com/inadimplência: pedidos onde este vendedor fez a venda (recebe comissão)
        const snapVend = await getDocs(query(collection(db, 'pedidos'), where('vendedor', '==', nome)));
        const pedRef = snapVend.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((p) => { const dv = p.dataVenda || ''; return dv >= dataInicio && dv <= dataFim; });

        const totalFatRef = pedRef.reduce((s, p) => s + Number(p.faturamento || 0), 0);
        const totalComRef = pedRef.reduce((s, p) => s + Number(p.comissao    || 0), 0);

        // Clientes: pedidos onde este vendedor é o responsável pela conta
        const snapResp = await getDocs(query(collection(db, 'pedidos'), where('vendedorResponsavel', '==', nome)));
        const pedResp = snapResp.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((p) => { const dv = p.dataVenda || ''; return dv >= dataInicio && dv <= dataFim; });
        const cnpjsUnicos       = [...new Set(pedResp.map((p) => normalizarCnpj(p.cnpj) || p.cliente).filter(Boolean))];
        const clientesAtivosRef = cnpjsUnicos.length;
        const fatPorClienteRef  = clientesAtivosRef > 0 ? totalFatRef / clientesAtivosRef : 0;

        // Inadimplência: vencidos / total das vendas do vendedor
        const finRef     = await buscarFinanceiro(pedRef);
        const fatBloqRef = pedRef
          .filter((p) => finRef[finId(p)]?.statusGeral === 'ATRASADO')
          .reduce((s, p) => s + Number(p.faturamento || 0), 0);
        const inadimplenciaRef = totalFatRef > 0 ? fatBloqRef / totalFatRef : 0;

        const metricas = {
          totalFat:       totalFatRef,
          totalCom:       totalComRef,
          clientesAtivos: clientesAtivosRef,
          fatPorCliente:  fatPorClienteRef,
          inadimplencia:  inadimplenciaRef,
          dataInicio,
          dataFim,
        };
        salvarCacheDiario(cacheKey, metricas);
        setMetricasNivel(metricas);
      } catch (err) {
        console.error('Erro ao buscar métricas do nível:', err);
      }
    }
    buscarMetricasNivel();
  }, [nome]);

  // Calcula métricas de todos os vendedores (pódio) e líderes por produto — cache semanal
  useEffect(() => {
    async function calcularMetricasPodium() {
      try {
        const cachedPodium  = lerCache('p3_podium');
        const cachedLideres = lerCache('p3_categorias_v2');
        if (cachedPodium)  setMetricasVendedores(cachedPodium);
        if (cachedLideres) setLideres(cachedLideres);
        if (cachedPodium && cachedLideres) return;

        const dataInicio = ultimos30dias();
        const dataFim    = new Date().toISOString().slice(0, 10);

        const snap = await getDocs(
          query(collection(db, 'pedidos'),
            where('dataVenda', '>=', dataInicio),
            where('dataVenda', '<=', dataFim),
          )
        );
        const pedPeriodo = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // ── Agrupa por vendedor → fat / com ─────────────────────────────
        const porVendedor = {};
        pedPeriodo.forEach(p => {
          const v = String(p.vendedor || '').trim();
          if (v) {
            if (!porVendedor[v]) porVendedor[v] = [];
            porVendedor[v].push(p);
          }
        });

        // ── Totais de faturamento por vendedor (para cálculo de % por produto)
        const fatTotalVendedor = {};
        Object.entries(porVendedor).forEach(([v, peds]) => {
          fatTotalVendedor[v] = peds.reduce((s, p) => s + Number(p.faturamento || 0), 0);
        });

        // ── Agrupa por vendedorResponsavel → clientes ativos ─────────────
        const cnpjsPorResp = {};
        pedPeriodo.forEach(p => {
          const v    = String(p.vendedorResponsavel || '').trim();
          const cnpj = normalizarCnpj(p.cnpj) || p.cliente;
          if (v && cnpj) {
            if (!cnpjsPorResp[v]) cnpjsPorResp[v] = new Set();
            cnpjsPorResp[v].add(cnpj);
          }
        });

        const finMap = await buscarFinanceiro(pedPeriodo);

        // ── Métricas do pódio ────────────────────────────────────────────
        if (!cachedPodium) {
          const metricas = Object.entries(porVendedor).map(([vendedor, peds]) => {
            const totalFat       = peds.reduce((s, p) => s + Number(p.faturamento || 0), 0);
            const totalCom       = peds.reduce((s, p) => s + Number(p.comissao    || 0), 0);
            const clientesAtivos = cnpjsPorResp[vendedor]?.size ?? 0;
            const fatPorCliente  = clientesAtivos > 0 ? totalFat / clientesAtivos : 0;
            const fatBloq        = peds
              .filter(p => finMap[finId(p)]?.statusGeral === 'ATRASADO')
              .reduce((s, p) => s + Number(p.faturamento || 0), 0);
            const comissaoPercent      = totalFat > 0 ? (totalCom / totalFat) * 100 : 0;
            const inadimplenciaPercent = totalFat > 0 ? (fatBloq  / totalFat) * 100 : 0;
            return { id: vendedor, vendedor, totalFat, comissaoPercent, inadimplenciaPercent, clientesAtivos, fatPorCliente };
          });
          salvarCache('p3_podium', metricas);
          setMetricasVendedores(metricas);
        }

        // ── Líderes por produto ──────────────────────────────────────────
        if (!cachedLideres) {
          // fat por produto e fat por produto×vendedor
          const porProduto = {}; // produto → { totalFat, vendedores: { nome → fat } }
          pedPeriodo.forEach(p => {
            const categoria = String(p.categoriaProduto || '').trim();
            const vendedor  = String(p.vendedor || '').trim();
            if (!categoria || !vendedor) return;
            if (!porProduto[categoria]) porProduto[categoria] = { totalFat: 0, vendedores: {} };
            porProduto[categoria].totalFat += Number(p.faturamento || 0);
            porProduto[categoria].vendedores[vendedor] = (porProduto[categoria].vendedores[vendedor] || 0) + Number(p.faturamento || 0);
          });

          const novoLideres = Object.entries(porProduto)
            .filter(([, d]) => d.totalFat >= 1000)
            .map(([categoria, d]) => {
              let destaqueVendedor = null;
              let destaquePercent  = 0;
              // pct por vendedor (apenas os com volume >= 20k) — usado para o insight
              const pctPorVendedor = {};
              Object.entries(d.vendedores).forEach(([v, fatProd]) => {
                const fatTotal = fatTotalVendedor[v] || 0;
                if (fatTotal < 20000) return;
                const pct = (fatProd / fatTotal) * 100;
                pctPorVendedor[v] = pct;
                if (pct > destaquePercent) { destaquePercent = pct; destaqueVendedor = v; }
              });
              return { categoria, totalFat: d.totalFat, destaqueVendedor, destaquePercent, pctPorVendedor };
            })
            .sort((a, b) => b.totalFat - a.totalFat);

          salvarCache('p3_categorias_v2', novoLideres);
          setLideres(novoLideres);
        }

      } catch (err) {
        console.error('Erro ao calcular métricas do pódio:', err);
        setMetricasVendedores([]);
        setLideres([]);
      }
    }
    calcularMetricasPodium();
  }, []);

  // Calcula progressão de nível dia a dia no mês selecionado
  // Para cada dia D: nível = resultado dos ÚLTIMOS 30 DIAS a partir de D
  useEffect(() => {
    if (carregando || !pedidosJanela.length) return;

    const hj             = new Date();
    const isCurrentMonth = ano === hj.getFullYear() && mes === hj.getMonth() + 1;
    const diasNoMes      = new Date(ano, mes, 0).getDate();
    const lastDay        = isCurrentMonth ? hj.getDate() : diasNoMes;

    const nivelPorDia = [];
    for (let d = 1; d <= lastDay; d++) {
      const dStr    = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const d30Date = new Date(ano, mes - 1, d);
      d30Date.setDate(d30Date.getDate() - 30);
      const d30Str  = d30Date.toISOString().slice(0, 10);

      // Pedidos do vendedor nos últimos 30 dias a partir de D
      const pedD = pedidosJanela.filter(p => {
        const dv = p.dataVenda || '';
        return dv >= d30Str && dv <= dStr;
      });
      if (!pedD.length) { nivelPorDia.push(null); continue; }

      const fat = pedD.reduce((s, p) => s + Number(p.faturamento || 0), 0);
      const com = pedD.reduce((s, p) => s + Number(p.comissao    || 0), 0);

      // Clientes ativos via vendedorResponsavel nos mesmos 30 dias
      const cliD = new Set(
        pedidosRespJanela
          .filter(p => { const dv = p.dataVenda || ''; return dv >= d30Str && dv <= dStr; })
          .map(p => normalizarCnpj(p.cnpj) || p.cliente)
          .filter(Boolean)
      ).size;

      const fatBloqD = pedD
        .filter(p => financeiroJanela[finId(p)]?.statusGeral === 'ATRASADO')
        .reduce((s, p) => s + Number(p.faturamento || 0), 0);

      const comPct  = fat > 0 ? (com / fat) * 100 : 0;
      const inadPct = fat > 0 ? (fatBloqD / fat) * 100 : 0;
      const fatCli  = cliD > 0 ? fat / cliD : 0;

      const n = [...NIVEIS_COMERCIAIS].reverse().find(n =>
        comPct  >= n.comissaoMinima    &&
        inadPct <= n.inadimplenciaMax  &&
        cliD    >= n.clientesAtivosMin &&
        fatCli  >= n.fatPorClienteMin
      );
      nivelPorDia.push(n?.nivel ?? null);
    }

    const diasPorNivel = {};
    nivelPorDia.forEach(n => {
      const k = n ?? '—';
      diasPorNivel[k] = (diasPorNivel[k] || 0) + 1;
    });

    // Nível majoritário: mais dias; empate → nível mais alto
    let nivelMaioria = null;
    let maxDias = 0;
    Object.entries(diasPorNivel).forEach(([k, cnt]) => {
      if (k === '—') return;
      const idx     = NIVEIS_COMERCIAIS.findIndex(n => n.nivel === k);
      const prevIdx = nivelMaioria ? NIVEIS_COMERCIAIS.findIndex(n => n.nivel === nivelMaioria.nivel) : -1;
      if (cnt > maxDias || (cnt === maxDias && idx > prevIdx)) {
        maxDias = cnt;
        nivelMaioria = NIVEIS_COMERCIAIS[idx];
      }
    });

    setProgressaoNivel({ diasPorNivel, nivelMaioria, totalDias: lastDay });
  }, [pedidosJanela, pedidosRespJanela, financeiroJanela, mes, ano, carregando]);

  useEffect(() => {
    setFiltroAtrasado(false);
    setExpandidos(new Set());
    setProgressaoNivel(null);
    setNivelExpanded(false);
    setPedidosJanela([]);
    setPedidosRespJanela([]);
    setFinanceiroJanela({});
    if (!nome) return;
    async function buscar() {
      setCarregando(true);
      try {
        const q = query(collection(db, 'pedidos'), where('vendedor', '==', nome));
        const snap = await getDocs(q);
        const prefixo = `${ano}-${String(mes).padStart(2, '0')}`;

        // Todos os pedidos do vendedor (sem filtro de data — já vem do Firestore)
        const todos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // Extrato: apenas o mês selecionado
        const filtrados = todos
          .filter((p) => (p.dataVenda || '').startsWith(prefixo))
          .sort((a, b) => (b.dataVenda || '').localeCompare(a.dataVenda || ''));
        setPedidos(filtrados);

        // Janela para progressão de nível: [1º dia do mês − 30 dias, último dia do mês]
        const janelaStartDate = new Date(ano, mes - 1, 1);
        janelaStartDate.setDate(janelaStartDate.getDate() - 30);
        const janelaStart = janelaStartDate.toISOString().slice(0, 10);
        const janelaEnd   = `${ano}-${String(mes).padStart(2, '0')}-${String(new Date(ano, mes, 0).getDate()).padStart(2, '0')}`;
        const janela = todos.filter((p) => {
          const dv = p.dataVenda || '';
          return dv >= janelaStart && dv <= janelaEnd;
        });
        setPedidosJanela(janela);

        const [fin, cli, snapPag, snapResp, finJanela] = await Promise.all([
          buscarFinanceiro(filtrados),
          buscarClientes([...new Set(filtrados.map((p) => normalizarCnpj(p.cnpj)).filter(Boolean))]),
          getDocs(query(collection(db, 'pagamentosComissao'), where('vendedor', '==', nome))),
          getDocs(query(collection(db, 'pedidos'), where('vendedorResponsavel', '==', nome))),
          buscarFinanceiro(janela),
        ]);
        setFinanceiro(fin);
        setClientes(cli);
        setFinanceiroJanela(finJanela);

        const pago = snapPag.docs
          .map((d) => d.data())
          .filter((p) => p.mes === mes && p.ano === ano)
          .reduce((s, p) => s + Number(p.valor || 0), 0);
        setTotalPago(pago);

        // Pedidos via vendedorResponsavel — janela completa e filtro do mês
        const todosResp = snapResp.docs.map((d) => d.data());
        const respJanela = todosResp.filter((p) => {
          const dv = p.dataVenda || '';
          return dv >= janelaStart && dv <= janelaEnd;
        });
        setPedidosRespJanela(respJanela);

        const respMes = respJanela.filter((p) => (p.dataVenda || '').startsWith(prefixo));
        setPedidosResp(respMes);

        const cliMes = new Set(
          respMes.map((p) => normalizarCnpj(p.cnpj) || p.cliente).filter(Boolean)
        ).size;
        setClientesDoMes(cliMes);
      } catch (err) {
        console.error(err);
      } finally {
        setCarregando(false);
      }
    }
    buscar();
  }, [nome, mes, ano]);

  function toggleExpandir(id) {
    setExpandidos((prev) => {
      const novo = new Set(prev);
      novo.has(id) ? novo.delete(id) : novo.add(id);
      return novo;
    });
  }

  const totalFaturamento  = pedidos.reduce((s, p) => s + Number(p.faturamento || 0), 0);
  const totalComissao     = pedidos.reduce((s, p) => s + Number(p.comissao    || 0), 0);
  const comissaoPaga      = pedidos.filter((p) => financeiro[finId(p)]?.statusGeral === 'RECEBIDO').reduce((s, p) => s + Number(p.comissao || 0), 0);
  const comissaoBloqueada    = pedidos.filter((p) => financeiro[finId(p)]?.statusGeral === 'ATRASADO').reduce((s, p) => s + Number(p.comissao    || 0), 0);
  const faturamentoBloqueado = pedidos.filter((p) => financeiro[finId(p)]?.statusGeral === 'ATRASADO').reduce((s, p) => s + Number(p.faturamento || 0), 0);

  // ── Nível do mês (majoritário — nível em que ficou por mais dias) ────────
  const nivelDoMes   = progressaoNivel?.nivelMaioria ?? null;
  const adicionalMes = nivelDoMes?.adicionalComissao > 0
    ? (nivelDoMes.adicionalComissao / 100) * comissaoPaga
    : 0;

  const saldo = (comissaoPaga + adicionalMes) - totalPago;

  // ── Métricas para nível comercial (sempre mês anterior) ────────────────
  // Mantidas como fallback enquanto metricasNivel carrega
  const clientesAtivos  = new Set(pedidos.map((p) => normalizarCnpj(p.cnpj) || p.cliente).filter(Boolean)).size;
  const fatPorCliente   = clientesAtivos > 0 ? totalFaturamento / clientesAtivos : 0;
  const inadimplencia   = totalFaturamento > 0 ? faturamentoBloqueado / totalFaturamento : 0;

  // Nível é baseado no fechamento do mês anterior (metricasNivel), com fallback para o mês atual
  const mNivel = metricasNivel ?? { totalFat: totalFaturamento, totalCom: totalComissao, clientesAtivos, fatPorCliente, inadimplencia };

  // comissaoMinima e inadimplenciaMax estão em % (ex: 3 = 3%) | fatPorClienteMin em R$
  const comissaoPercentNivel      = mNivel.totalFat > 0 ? (mNivel.totalCom / mNivel.totalFat) * 100 : 0;
  const inadimplenciaPercentNivel = mNivel.inadimplencia * 100;

  // "N+" = N.5 para ordenação correta (1 < 1+ < 2 < 2+ ...)
  // NIVEIS_COMERCIAIS já está ordenado, mas a função garante para o reverse().find()
  const passaNivel = (n) =>
    comissaoPercentNivel      >= n.comissaoMinima    &&
    inadimplenciaPercentNivel <= n.inadimplenciaMax  &&
    mNivel.clientesAtivos     >= n.clientesAtivosMin &&
    mNivel.fatPorCliente      >= n.fatPorClienteMin;

  // Nível atual = o mais difícil que passa (último na lista, que já está easiest→hardest)
  const nivelAtual = [...NIVEIS_COMERCIAIS].reverse().find(passaNivel) ?? null;

  // Próximo nível = o primeiro que ainda não passa
  const nivelAlvo = NIVEIS_COMERCIAIS.find((n) => !passaNivel(n)) ?? null;

  const vendas = agruparPorVenda(pedidos, financeiro, clientes);
  const vendasVisiveis = filtroAtrasado ? vendas.filter((v) => v.status === 'ATRASADO') : vendas;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.headerLeft}>
            {onVoltar && <button onClick={onVoltar} style={styles.btnVoltar}>← Voltar</button>}
            <div>
              <h1 style={styles.headerTitle}>Painel P3</h1>
              <p style={styles.headerSub}>{nomeDisplay}</p>
            </div>
          </div>
          {!onVoltar && <button onClick={logout} style={styles.btnSair}>Sair</button>}
        </div>

        {/* Abas de navegação */}
        <div style={styles.abas}>
          {[
            { id: 'meta',     label: '📊 Painel Geral' },
            { id: 'extrato',  label: '💰 Extrato de Comissões' },
            { id: 'clientes', label: '🏢 Clientes' },
            { id: 'hoje',     label: '📅 Hoje' },
          ].map((a) => (
            <button
              key={a.id}
              onClick={() => setAba(a.id)}
              style={{
                ...styles.abaBtn,
                borderBottom: aba === a.id ? '3px solid #fff' : '3px solid transparent',
                opacity: aba === a.id ? 1 : 0.6,
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </header>

      <main style={styles.main}>

        {/* ── ABA HOJE ───────────────────────────────────── */}
        {aba === 'hoje' && (
          <LinhaDoTempo vendedorNome={nome} />
        )}

        {/* ── ABA EXTRATO ────────────────────────────────── */}
        {aba === 'extrato' && (<>
          <div style={styles.filtros}>
            <select value={mes} onChange={(e) => setMes(Number(e.target.value))} style={styles.select}>
              {MESES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
            <select value={ano} onChange={(e) => setAno(Number(e.target.value))} style={styles.select}>
              {anos.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {/* Banner do nível do mês */}
          {!carregando && progressaoNivel && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px', padding: '14px 16px', marginBottom: '16px' }}>

              {/* Linha principal: título + botão expandir */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                <div>
                  {nivelDoMes ? (
                    <span style={{ fontSize: '14px', fontWeight: '700', color: '#15803d' }}>
                      🏆 Você fechou {MESES[mes - 1]} no Nível {nivelDoMes.nivel}
                    </span>
                  ) : (
                    <span style={{ fontSize: '14px', fontWeight: '700', color: '#6b7280' }}>
                      📊 Nível em {MESES[mes - 1]}: sem nível atingido
                    </span>
                  )}
                  {adicionalMes > 0 ? (
                    <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#16a34a' }}>
                      +{nivelDoMes.adicionalComissao}% adicional sobre comissão recebida = <strong>{moeda(adicionalMes)}</strong>
                    </p>
                  ) : (
                    <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#6b7280' }}>
                      {nivelDoMes ? 'Este nível não tem adicional de comissão.' : 'Nenhum nível atingido no mês.'}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => setNivelExpanded(e => !e)}
                  style={{ background: 'none', border: '1px solid #86efac', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px', color: '#15803d', fontWeight: '600', whiteSpace: 'nowrap', fontFamily: 'inherit' }}
                >
                  {nivelExpanded ? '▲ Menos' : '▼ Detalhes'}
                </button>
              </div>

              {/* Seção expandível */}
              {nivelExpanded && (
                <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #bbf7d0' }}>

                  {/* Explicação do sistema */}
                  <div style={{ background: '#fff', border: '1px solid #d1fae5', borderRadius: '8px', padding: '10px 12px', marginBottom: '10px' }}>
                    <p style={{ margin: '0 0 4px', fontSize: '12px', fontWeight: '700', color: '#065f46' }}>ℹ️ Como funciona o nível do mês</p>
                    <p style={{ margin: 0, fontSize: '12px', color: '#374151', lineHeight: 1.5 }}>
                      O nível do mês é calculado dia a dia. Cada dia, verificamos qual nível você atingia com base no acumulado de faturamento, comissão, clientes e inadimplência até aquela data. O nível final do mês é o que ocorreu por <strong>mais dias</strong>. O adicional é aplicado sobre a comissão já recebida (boletos pagos).
                    </p>
                  </div>

                  {/* Dias por nível */}
                  <p style={{ margin: '0 0 6px', fontSize: '11px', fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Distribuição de dias
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {/* Dias sem nível */}
                    {(progressaoNivel.diasPorNivel['—'] || 0) > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: '#9ca3af', minWidth: '70px' }}>Sem nível</span>
                        <div style={{ flex: 1, height: '6px', background: '#e5e7eb', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${(progressaoNivel.diasPorNivel['—'] / progressaoNivel.totalDias) * 100}%`, background: '#d1d5db', borderRadius: '3px' }} />
                        </div>
                        <span style={{ fontSize: '12px', color: '#9ca3af', minWidth: '50px', textAlign: 'right' }}>
                          {progressaoNivel.diasPorNivel['—']} {progressaoNivel.diasPorNivel['—'] === 1 ? 'dia' : 'dias'}
                        </span>
                      </div>
                    )}
                    {/* Dias por nível (ordenado do mais alto ao mais baixo) */}
                    {[...NIVEIS_COMERCIAIS].reverse().map(n => {
                      const dias = progressaoNivel.diasPorNivel[n.nivel] || 0;
                      if (!dias) return null;
                      const isMaioria = nivelDoMes?.nivel === n.nivel;
                      return (
                        <div key={n.nivel} style={{ display: 'flex', alignItems: 'center', gap: '8px', background: isMaioria ? '#dcfce7' : 'transparent', borderRadius: '5px', padding: isMaioria ? '3px 5px' : '0' }}>
                          <span style={{ fontSize: '12px', fontWeight: isMaioria ? '700' : '500', color: isMaioria ? '#15803d' : '#374151', minWidth: '70px' }}>
                            Nível {n.nivel}{isMaioria ? ' ←' : ''}
                          </span>
                          <div style={{ flex: 1, height: '6px', background: '#e5e7eb', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${(dias / progressaoNivel.totalDias) * 100}%`, background: isMaioria ? '#16a34a' : '#86efac', borderRadius: '3px' }} />
                          </div>
                          <span style={{ fontSize: '12px', fontWeight: isMaioria ? '700' : '400', color: isMaioria ? '#15803d' : '#6b7280', minWidth: '50px', textAlign: 'right' }}>
                            {dias} {dias === 1 ? 'dia' : 'dias'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#9ca3af' }}>
                    Total contabilizado: {progressaoNivel.totalDias} dias
                  </p>
                </div>
              )}
            </div>
          )}

          <div style={styles.cards}>
            <div style={{ ...styles.card, borderLeft: '4px solid #0f3460' }}>
              <p style={styles.cardLabel}>Faturamento do período</p>
              <p style={styles.cardValor}>{moeda(totalFaturamento)}</p>
              <p style={styles.cardSub}>{vendas.length} {vendas.length === 1 ? 'venda' : 'vendas'} · {pedidos.length} produtos</p>
            </div>
            <div style={{ ...styles.card, borderLeft: '4px solid #16a34a' }}>
              <p style={styles.cardLabel}>Comissão disponível</p>
              <p style={{ ...styles.cardValor, color: '#16a34a' }}>{moeda(comissaoPaga + adicionalMes)}</p>
              <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #f0fdf4', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {/* Sempre mostra a linha de comissão base quando o nível do mês está disponível */}
                {progressaoNivel && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: '#6b7280' }}>Comissão base</span>
                    <span style={{ fontWeight: '600', color: '#374151' }}>{moeda(comissaoPaga)}</span>
                  </div>
                )}
                {progressaoNivel && adicionalMes > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: '#16a34a' }}>+{nivelDoMes.adicionalComissao}% Nível {nivelDoMes.nivel}</span>
                    <span style={{ fontWeight: '600', color: '#16a34a' }}>+{moeda(adicionalMes)}</span>
                  </div>
                )}
                {progressaoNivel && adicionalMes === 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: '#9ca3af' }}>
                      {nivelDoMes ? `Nível ${nivelDoMes.nivel} — sem adicional` : 'Sem nível — sem adicional'}
                    </span>
                    <span style={{ color: '#9ca3af' }}>R$ 0,00</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: '#6b7280' }}>Valor pago</span>
                  <span style={{ fontWeight: '600', color: '#374151' }}>{moeda(totalPago)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: '12px' }}>
                  <div>
                    <span style={{ color: '#16a34a', fontWeight: '700' }}>Saldo</span>
                    <p style={{ margin: '1px 0 0', fontSize: '11px', color: '#16a34a' }}>Programado p/ {proximaSegunda()}</p>
                  </div>
                  <span style={{ fontWeight: '700', color: '#16a34a', fontSize: '13px' }}>{moeda(saldo)}</span>
                </div>
              </div>
            </div>
            <div
              onClick={() => setFiltroAtrasado((f) => !f)}
              style={{ ...styles.card, borderLeft: '4px solid #dc2626', cursor: 'pointer', boxShadow: filtroAtrasado ? '0 0 0 3px #fecaca' : '0 1px 4px rgba(0,0,0,0.07)' }}
            >
              <p style={styles.cardLabel}>Comissão bloqueada 🔒</p>
              <p style={{ ...styles.cardValor, color: '#dc2626' }}>{moeda(comissaoBloqueada)}</p>
              <p style={{ ...styles.cardSub, color: '#dc2626' }}>{filtroAtrasado ? 'Clique para ver todas' : 'Clique para ver em atraso'}</p>
              {faturamentoBloqueado > 0 && (
                <p style={{ ...styles.cardSub, marginTop: '6px' }}>Fat. em atraso: {moeda(faturamentoBloqueado)}</p>
              )}
            </div>
            <div style={{ ...styles.card, borderLeft: '4px solid #9ca3af' }}>
              <p style={styles.cardLabel}>Comissão total do período</p>
              <p style={{ ...styles.cardValor, color: '#374151' }}>{moeda(totalComissao)}</p>
              <p style={styles.cardSub}>{totalFaturamento > 0 ? percent((totalComissao / totalFaturamento) * 100) : '0%'} do faturamento</p>
            </div>
          </div>

          {filtroAtrasado && (
            <div style={styles.bannerFiltro}>
              <span>🔴 Mostrando apenas vendas com boletos em atraso</span>
              <button onClick={() => setFiltroAtrasado(false)} style={styles.btnLimparFiltro}>✕ Mostrar todas</button>
            </div>
          )}

          <div style={styles.legenda}>
            <span style={{ ...styles.legendaItem, color: '#16a34a' }}>● Pago</span>
            <span style={{ ...styles.legendaItem, color: '#9ca3af' }}>● Em aberto</span>
            <span style={{ ...styles.legendaItem, color: '#dc2626' }}>● Atrasado</span>
          </div>

          {carregando ? (
            <div style={styles.centralizando}>
              <div style={styles.spinner} />
              <p style={{ color: '#6b7280' }}>Buscando pedidos...</p>
            </div>
          ) : vendasVisiveis.length === 0 ? (
            <div style={styles.vazio}>
              <p>{filtroAtrasado ? 'Nenhuma venda em atraso neste período.' : `Nenhuma venda encontrada em ${MESES[mes - 1]} de ${ano}.`}</p>
            </div>
          ) : (
            <div style={styles.lista}>
              {vendasVisiveis.map((venda) => {
                const expandido = expandidos.has(venda.id);
                const lbl = venda.status ? labelStatus(venda.status) : null;
                const corCom = corComissao(venda.status);
                return (
                  <div key={venda.id}>
                    <div style={styles.vendaRow}>
                      <button
                        onClick={() => toggleExpandir(venda.id)}
                        style={{ ...styles.btnExpandir, background: expandido ? '#0f3460' : '#f1f5f9', color: expandido ? '#fff' : '#0f3460' }}
                        title={expandido ? 'Recolher produtos' : 'Ver produtos'}
                      >
                        {expandido ? '−' : '+'}
                      </button>

                      <div style={styles.vendaInfo}>
                        <span style={styles.vendaCliente}>{venda.cliente}</span>
                        <div style={styles.vendaMeta}>
                          <span style={styles.itemInfo}>{formatarData(venda.dataVenda)}</span>
                          {venda.estado && <span style={styles.itemInfo}>{venda.estado}</span>}
                          <span style={styles.itemInfo}>#{venda.numeroVenda}</span>
                          <span style={styles.itemInfo}>{venda.pedidos.length} {venda.pedidos.length === 1 ? 'produto' : 'produtos'}</span>
                          <span style={{ ...styles.badge }}>{venda.situacao}</span>
                          {lbl && <span style={{ ...styles.badgeStatus, color: lbl.cor, background: lbl.bg }}>{lbl.texto}</span>}
                          {venda.status === 'ATRASADO' && venda.diasAtraso > 0 && (
                            <span style={styles.badgeDias}>{venda.diasAtraso} {venda.diasAtraso === 1 ? 'dia' : 'dias'} em atraso</span>
                          )}
                          {venda.statusFinanceiro && (() => {
                            const c = corStatus(venda.statusFinanceiro);
                            return (
                              <span style={{ ...styles.badgeStatus, color: c.cor, background: c.bg }}>
                                ★ {venda.statusFinanceiro}
                              </span>
                            );
                          })()}
                        </div>
                      </div>

                      <div style={styles.vendaValores}>
                        <span style={{ ...styles.itemComissao, color: corCom }}>{moeda(venda.totalCom)}</span>
                        <span style={styles.itemPercent}>
                          {venda.totalFat > 0 ? `${(venda.totalCom / venda.totalFat * 100).toFixed(1)}%` : '—'}
                        </span>
                        <span style={{ ...styles.itemInfo, fontSize: '11px' }}>Fat.: {moeda(venda.totalFat)}</span>
                      </div>
                    </div>

                    {expandido && (
                      <div style={styles.produtosContainer}>
                        {venda.pedidos.map((p, idx) => (
                          <div key={p.id} style={{ ...styles.produtoRow, background: idx % 2 === 0 ? '#f8fafc' : '#f1f5f9' }}>
                            <div style={styles.produtoInfo}>
                              <span style={styles.produtoNome}>{p.produto || '—'}</span>
                              {p.codigoProduto && <span style={styles.produtoCodigo}>{p.codigoProduto}</span>}
                            </div>
                            <div style={styles.produtoValores}>
                              <span style={styles.produtoQtd}>{Number(p.quantidadeProdutos || 1)}x {moeda(p.precoUnitario)}</span>
                              <span style={styles.produtoFat}>Fat.: {moeda(p.faturamento)}</span>
                              <span style={{ ...styles.produtoCom, color: corCom }}>
                                Com.: {moeda(p.comissao)}
                                {Number(p.faturamento) > 0 && (
                                  <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: '11px' }}>
                                    {' '}({(Number(p.comissao || 0) / Number(p.faturamento) * 100).toFixed(1)}%)
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>)}

        {/* ── ABA CLIENTES ───────────────────────────────── */}
        {aba === 'clientes' && (
          carregandoClientes ? (
            <div style={styles.centralizando}>
              <div style={styles.spinner} />
              <p style={{ color: '#6b7280' }}>Buscando clientes...</p>
            </div>
          ) : erroClientes ? (
            <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '10px', padding: '16px', fontSize: '13px', color: '#92400e' }}>
              ⚠️ {erroClientes}
            </div>
          ) : (
            <div>
              {todosClientes.length > 0 && (
                <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#6b7280' }}>
                  {todosClientes.length} {todosClientes.length === 1 ? 'cliente' : 'clientes'} na carteira
                </p>
              )}

              {/* Bloqueados — sempre aberto por padrão */}
              <GrupoClientes
                titulo="🔒 Bloqueados"
                cor="#dc2626"
                lista={todosClientes.filter((c) => estaBloqueado(c.statusBloqueio))}
                defaultAberto={true}
              />

              {/* Tabela de carteira ordenada por FMM */}
              {todosClientes.length > 0 && (
                <div style={{ background: '#fff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: '700', fontSize: '14px', color: '#374151' }}>📋 Carteira completa</span>
                    <span style={{ fontSize: '12px', color: '#9ca3af' }}>ordenado por faturamento médio</span>
                  </div>
                  {/* Cards de clientes */}
                  {[...todosClientes]
                    .sort((a, b) => b.fatMedioMensal - a.fatMedioMensal)
                    .map((c, idx) => {
                      const { cor, bg } = corStatus(c.status);
                      const bloq = estaBloqueado(c.statusBloqueio);
                      return (
                        <div
                          key={c.cnpj || c.nome}
                          style={{
                            padding: '12px 16px',
                            background: idx % 2 === 0 ? '#fff' : '#f8fafc',
                            borderBottom: '1px solid #f0f0f0',
                          }}
                        >
                          {/* Nome + status */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '5px' }}>
                            <span style={{ fontSize: '13px', fontWeight: '600', color: bloq ? '#dc2626' : '#111827', flex: 1, lineHeight: '1.3' }}>
                              {bloq && '🔒 '}{c.nome}
                            </span>
                            {c.status && (
                              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '20px', fontWeight: '600', color: cor, background: bg, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                {c.status}
                              </span>
                            )}
                          </div>
                          {/* Detalhes */}
                          <div style={{ display: 'flex', gap: '12px', fontSize: '12px', color: '#6b7280', flexWrap: 'wrap' }}>
                            {c.cidade && <span>{c.cidade}</span>}
                            {c.fatMedioMensal > 0 && <span>FMM: <strong style={{ color: '#111827' }}>{moeda(c.fatMedioMensal)}</strong></span>}
                            {c.pontuacao > 0 && <span>Pont: {moeda(c.pontuacao)}</span>}
                            {c.score != null && <span>Score: {c.score}</span>}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}

              {todosClientes.length === 0 && (
                <div style={styles.vazio}><p>Nenhum cliente encontrado.</p></div>
              )}
            </div>
          )
        )}

        {/* ── ABA META ───────────────────────────────────── */}
        {aba === 'meta' && (<>

          {/* ── Ranking compacto ── */}
          {metricasVendedores === null ? (
            <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '13px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginBottom: '16px' }}>
              ⏳ Carregando ranking...
            </div>
          ) : metricasVendedores.length === 0 ? (
            <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '13px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginBottom: '16px' }}>
              Sem dados de vendedores para o período.
            </div>
          ) : (
            <RankingNiveis metricasVendedores={metricasVendedores} vendedorAtual={nome} />
          )}

          <div style={styles.filtros}>
            <select value={mes} onChange={(e) => setMes(Number(e.target.value))} style={styles.select}>
              {MESES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
            <select value={ano} onChange={(e) => setAno(Number(e.target.value))} style={styles.select}>
              {anos.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <MetaCard vendedor={nome} mes={mes} ano={ano} fatAtual={totalFaturamento} />

          {/* ── Gráfico de faturamento mensal ── */}
          <GraficoVendasMensais
            vendedor={nome}
            titulo="Seu faturamento mensal · últimos 12 meses"
          />

          {/* ── Nível Comercial (painel pessoal — só para o próprio vendedor) ── */}
          {metricasNivel && (
            <div style={{ background: '#fff', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginTop: '16px' }}>

              {/* Cabeçalho: nível atual + adicional + clientes novos */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '4px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nível Comercial do Dia</p>
                  <p style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: '800', color: nivelAtual ? '#0f3460' : '#9ca3af' }}>
                    {nivelAtual ? `🏆 ${nivelAtual.nivel}` : '— Sem nível'}
                  </p>
                  {novosClientes30d > 0 && (
                    <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#16a34a' }}>
                      +{novosClientes30d} {novosClientes30d === 1 ? 'cliente novo' : 'clientes novos'} nos últimos 30 dias
                    </p>
                  )}
                </div>
                {nivelAtual && Number(nivelAtual.adicionalComissao) > 0 && (
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ margin: 0, fontSize: '11px', color: '#6b7280' }}>Adicional de comissão</p>
                    <p style={{ margin: 0, fontSize: '20px', fontWeight: '800', color: '#16a34a' }}>+{nivelAtual.adicionalComissao}%</p>
                  </div>
                )}
              </div>

              {/* Critérios do próximo nível */}
              {nivelAlvo ? (() => {
                const criterios = [
                  { label: 'Comissão do mês',       atual: comissaoPercentNivel,      ref: nivelAlvo.comissaoMinima,    tipo: 'min', formatar: (v) => `${v.toFixed(1)}%` },
                  { label: 'Inadimplência',          atual: inadimplenciaPercentNivel, ref: nivelAlvo.inadimplenciaMax,  tipo: 'max', formatar: (v) => `${v.toFixed(1)}%` },
                  { label: 'Clientes ativos',        atual: mNivel.clientesAtivos,     ref: nivelAlvo.clientesAtivosMin, tipo: 'min', formatar: (v) => `${v}`             },
                  { label: 'Fat. médio por cliente', atual: mNivel.fatPorCliente,      ref: nivelAlvo.fatPorClienteMin,  tipo: 'min', formatar: moeda                     },
                ];
                const passou = (c) => c.tipo === 'min' ? c.atual >= c.ref : c.atual <= c.ref;
                const faltando = criterios.filter((c) => !passou(c));

                return (
                  <>
                    {/* ── Smart insight banner ── */}
                    {(() => {
                      const fatBloqNivel = mNivel.totalFat * mNivel.inadimplencia;

                      const gerarInsight = (c) => {
                        if (c.label === 'Inadimplência') {
                          const precisaReceber = Math.max(0, fatBloqNivel - mNivel.totalFat * (nivelAlvo.inadimplenciaMax / 100));
                          return {
                            emoji: '💸',
                            texto: `Receba ${moeda(precisaReceber)} dos ${moeda(fatBloqNivel)} em atraso — sua inadimplência cai para ${nivelAlvo.inadimplenciaMax}% e você atinge o Nível ${nivelAlvo.nivel}`,
                          };
                        }
                        if (c.label === 'Clientes ativos') {
                          const faltam = nivelAlvo.clientesAtivosMin - mNivel.clientesAtivos;
                          return {
                            emoji: '🤝',
                            texto: `Abra ${faltam} novo${faltam > 1 ? 's' : ''} cliente${faltam > 1 ? 's' : ''} ativo${faltam > 1 ? 's' : ''} — você precisa de ${nivelAlvo.clientesAtivosMin} para o Nível ${nivelAlvo.nivel}, tem ${mNivel.clientesAtivos}`,
                          };
                        }
                        if (c.label === 'Fat. médio por cliente') {
                          // Encontra a categoria com maior gap de oportunidade nos líderes
                          let melhorCat = null;
                          let melhorDiff = 0;
                          if (lideres) {
                            lideres.forEach(l => {
                              const destaqueIsMe = normalizarVendedor(l.destaqueVendedor) === normalizarVendedor(nome);
                              if (destaqueIsMe) return;
                              const meuPct = l.pctPorVendedor?.[nome] ?? null;
                              if (meuPct === null) return;
                              const diff = l.destaquePercent - meuPct;
                              if (diff > melhorDiff) { melhorDiff = diff; melhorCat = l; }
                            });
                          }
                          if (melhorCat && melhorDiff > 10) {
                            const meuPct = melhorCat.pctPorVendedor[nome];
                            return {
                              emoji: '📦',
                              texto: `Foque em vender mais ${melhorCat.categoria}: ${normalizarVendedor(melhorCat.destaqueVendedor)} dedica ${melhorCat.destaquePercent.toFixed(1)}% das vendas nessa categoria, você apenas ${meuPct.toFixed(1)}% — é seu maior gap para atingir o Nível ${nivelAlvo.nivel}`,
                            };
                          }
                          const faltaFat = Math.max(0, nivelAlvo.fatPorClienteMin - mNivel.fatPorCliente);
                          return {
                            emoji: '📈',
                            texto: `Aumente ${moeda(Math.round(faltaFat))} por cliente para atingir o Nível ${nivelAlvo.nivel} — meta: ${moeda(nivelAlvo.fatPorClienteMin)}/cliente, você está em ${moeda(Math.round(mNivel.fatPorCliente))}`,
                          };
                        }
                        if (c.label === 'Comissão do mês') {
                          return {
                            emoji: '💰',
                            texto: `Foque em produtos de maior margem para subir sua comissão de ${c.atual.toFixed(1)}% para ${nivelAlvo.comissaoMinima}% e atingir o Nível ${nivelAlvo.nivel}`,
                          };
                        }
                        return null;
                      };

                      if (faltando.length === 1) {
                        const ins = gerarInsight(faltando[0]);
                        return ins ? (
                          <div style={{ margin: '14px 0 4px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', padding: '10px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                              <span style={{ fontSize: '18px', lineHeight: '1.3', flexShrink: 0 }}>{ins.emoji}</span>
                              <span style={{ fontSize: '13px', color: '#92400e', fontWeight: '600', lineHeight: '1.45' }}>{ins.texto}</span>
                            </div>
                          </div>
                        ) : null;
                      }

                      if (faltando.length > 1) {
                        const insights = faltando.map(c => {
                          const ins = gerarInsight(c);
                          return ins ? { ...ins, label: c.label } : null;
                        }).filter(Boolean);
                        return (
                          <div style={{ margin: '14px 0 4px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', padding: '10px 14px' }}>
                            <p style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: '700', color: '#92400e' }}>
                              ⚡ Para atingir o Nível {nivelAlvo.nivel}:
                            </p>
                            {insights.map(ins => (
                              <div key={ins.label} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '5px' }}>
                                <span style={{ fontSize: '15px', lineHeight: '1.35', flexShrink: 0 }}>{ins.emoji}</span>
                                <span style={{ fontSize: '12px', color: '#78350f', lineHeight: '1.4' }}>{ins.texto}</span>
                              </div>
                            ))}
                          </div>
                        );
                      }

                      return null;
                    })()}
                    {faltando.map((c) => (
                      <CriterioRow key={c.label} label={c.label} atual={c.atual}
                        minimo={c.tipo === 'min' ? c.ref : undefined}
                        maximo={c.tipo === 'max' ? c.ref : undefined}
                        formatar={c.formatar} />
                    ))}
                    {criterios.filter(passou).length > 0 && (
                      <div style={{ marginTop: '4px', opacity: 0.55 }}>
                        {criterios.filter(passou).map((c) => (
                          <CriterioRow key={c.label} label={c.label} atual={c.atual}
                            minimo={c.tipo === 'min' ? c.ref : undefined}
                            maximo={c.tipo === 'max' ? c.ref : undefined}
                            formatar={c.formatar} />
                        ))}
                      </div>
                    )}
                  </>
                );
              })() : nivelAtual ? (
                <p style={{ margin: '16px 0 0', fontSize: '13px', color: '#16a34a', fontWeight: '600', textAlign: 'center' }}>
                  🎉 Você está no nível máximo!
                </p>
              ) : null}

              <p style={{ margin: '12px 0 0', fontSize: '11px', color: '#9ca3af', textAlign: 'right' }}>
                {formatarData(metricasNivel.dataInicio)} – {formatarData(metricasNivel.dataFim)} · atualiza todo dia
              </p>
            </div>
          )}

          {/* ── Líder de Vendas por Categoria de Produto ── */}
          <div style={{ background: '#fff', borderRadius: '12px', padding: '16px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginTop: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '14px' }}>
              <p style={{ margin: 0, fontSize: '11px', fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                🥇 Líder de Vendas por Categoria · últimos 30 dias
              </p>
              <span style={{ fontSize: '10px', color: '#9ca3af' }}>
                📅 Atualiza toda segunda · próx. {proximaSegunda()}
              </span>
            </div>

            {lideres === null ? (
              <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: '13px', margin: '16px 0' }}>⏳ Carregando...</p>
            ) : lideres.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: '13px', margin: '16px 0' }}>Sem dados no período.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {lideres.map((l, i) => {
                  const isMe       = normalizarVendedor(l.destaqueVendedor) === normalizarVendedor(nome);
                  const meuPct     = l.pctPorVendedor?.[nome] ?? null;
                  const diff       = meuPct !== null ? l.destaquePercent - meuPct : null;
                  const temInsight = diff !== null && diff > 15 && !isMe;
                  const ordinal    = ['1º','2º','3º','4º','5º','6º','7º','8º','9º','10º'][i] || `${i+1}º`;
                  const corOrd     = i === 0 ? '#d97706' : i === 1 ? '#6b7280' : i === 2 ? '#b45309' : '#9ca3af';
                  return (
                    <div
                      key={l.categoria}
                      style={{
                        borderRadius: '10px',
                        padding: '12px 14px',
                        border: `1px solid ${temInsight ? '#fde68a' : isMe ? '#bfdbfe' : '#f0f0f0'}`,
                        background: temInsight ? '#fefce8' : isMe ? '#eff6ff' : '#fff',
                      }}
                    >
                      {/* Linha 1: posição + categoria + total */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                          <span style={{ fontSize: '13px', fontWeight: '800', color: corOrd }}>{ordinal}</span>
                          <span style={{ fontSize: '14px', fontWeight: '700', color: '#111827' }}>{l.categoria}</span>
                        </div>
                        <span style={{ fontSize: '12px', color: '#6b7280', fontWeight: '500' }}>{moeda(l.totalFat)}</span>
                      </div>
                      {/* Linha 2: destaque */}
                      <div style={{ fontSize: '12px', color: isMe ? '#1d4ed8' : '#6b7280', marginBottom: temInsight || isMe ? '8px' : '0' }}>
                        {isMe ? '👤 Você é o destaque' : normalizarVendedor(l.destaqueVendedor || '—')}
                        {' · '}{l.destaquePercent.toFixed(1)}% das vendas dele
                        {meuPct !== null && !isMe && <span style={{ color: '#9ca3af' }}> · você: {meuPct.toFixed(1)}%</span>}
                      </div>
                      {/* Insight */}
                      {temInsight && (
                        <div style={{ background: '#fef3c7', borderRadius: '7px', padding: '8px 10px' }}>
                          <p style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: '#92400e' }}>🚀 Oportunidade!</p>
                          <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#78350f', lineHeight: '1.4' }}>
                            {normalizarVendedor(l.destaqueVendedor)} faz {l.destaquePercent.toFixed(1)}% nessa categoria, você faz {meuPct.toFixed(1)}%.
                          </p>
                        </div>
                      )}
                      {isMe && (
                        <span style={{ fontSize: '12px', color: '#16a34a', fontWeight: '700' }}>✅ Você é o destaque!</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>)}

      </main>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f3f4f6', fontFamily: 'Inter, sans-serif' },
  header: { background: '#0f3460', color: '#fff', padding: '0 20px', paddingBottom: 0 },
  abas: { maxWidth: '960px', margin: '0 auto', display: 'flex', gap: '4px', paddingTop: '8px' },
  abaBtn: { background: 'none', border: 'none', color: '#fff', padding: '8px 16px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit', borderRadius: '6px 6px 0 0', transition: 'opacity 0.15s' },
  headerInner: { maxWidth: '960px', margin: '0 auto', padding: '16px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headerLeft: { display: 'flex', alignItems: 'center', gap: '12px' },
  headerTitle: { margin: 0, fontSize: '20px', fontWeight: '700' },
  headerSub: { margin: 0, fontSize: '13px', opacity: 0.8, marginTop: '2px' },
  btnSair: { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', padding: '7px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontFamily: 'inherit' },
  btnVoltar: { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', padding: '7px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontFamily: 'inherit' },
  main: { maxWidth: '960px', margin: '0 auto', padding: '24px 16px' },
  filtros: { display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' },
  select: { padding: '9px 14px', border: '1.5px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', outline: 'none' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '12px' },
  card: { background: '#fff', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  cardLabel: { margin: '0 0 6px', fontSize: '12px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' },
  cardValor: { margin: '0 0 4px', fontSize: '24px', fontWeight: '700', color: '#111827' },
  cardSub: { margin: 0, fontSize: '12px', color: '#9ca3af' },
  bannerFiltro: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px', fontSize: '13px', color: '#991b1b' },
  btnLimparFiltro: { background: 'none', border: '1px solid #fca5a5', color: '#dc2626', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit' },
  legenda: { display: 'flex', gap: '16px', marginBottom: '16px', padding: '0 4px' },
  legendaItem: { fontSize: '12px', fontWeight: '600' },
  lista: { background: '#fff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  // 1ª camada — linha da venda
  vendaRow: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px', borderBottom: '1px solid #f0f0f0' },
  btnExpandir: { flexShrink: 0, width: '28px', height: '28px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '16px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '2px', transition: 'background 0.15s' },
  vendaInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' },
  vendaCliente: { fontWeight: '700', fontSize: '14px', color: '#111827' },
  vendaMeta: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  vendaValores: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', flexShrink: 0 },
  // 2ª camada — produtos
  produtosContainer: { borderBottom: '2px solid #e5e7eb' },
  produtoRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px 10px 56px', gap: '12px' },
  produtoInfo: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 },
  produtoNome: { fontSize: '13px', color: '#374151', fontWeight: '500' },
  produtoCodigo: { fontSize: '11px', color: '#9ca3af' },
  produtoValores: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' },
  produtoQtd: { fontSize: '12px', color: '#6b7280' },
  produtoFat: { fontSize: '12px', color: '#6b7280' },
  produtoCom: { fontSize: '13px', fontWeight: '600' },
  // compartilhados
  itemComissao: { fontWeight: '700', fontSize: '16px' },
  itemPercent: { fontSize: '11px', color: '#9ca3af' },
  itemInfo: { fontSize: '12px', color: '#9ca3af' },
  badge: { fontSize: '11px', padding: '2px 8px', borderRadius: '20px', background: '#e0f2fe', color: '#0369a1', fontWeight: '600' },
  badgeStatus: { fontSize: '11px', padding: '2px 8px', borderRadius: '20px', fontWeight: '600' },
  badgeDias: { fontSize: '11px', padding: '2px 8px', borderRadius: '20px', background: '#fee2e2', color: '#dc2626', fontWeight: '600' },
  centralizando: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 0', gap: '12px' },
  spinner: { width: '32px', height: '32px', border: '3px solid #e5e7eb', borderTop: '3px solid #0f3460', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  vazio: { textAlign: 'center', padding: '60px 0', color: '#6b7280', background: '#fff', borderRadius: '12px' },
};

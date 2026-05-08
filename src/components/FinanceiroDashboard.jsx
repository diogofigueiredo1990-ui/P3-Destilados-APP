import { useState, useEffect } from 'react';
import { collection, query, where, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import { hojeISO } from '../utils/data';

const MESES = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
];

function moeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function proximaSegunda() {
  const d = new Date();
  const diff = (1 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Extrai finId do pedido (igual ao VendedorDashboard)
function extrairFinId(p) {
  const ca = String(p.contaAzul || '').trim();
  if (!ca) return null;
  const parts = String(p.chave || '').split('_');
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) return `${ca}_${parts[1]}`;
  return null;
}

// Extrai o estado do nome do vendedor (ex: "Diogo MG" → "MG")
function extrairEstado(nome) {
  const m = String(nome || '').match(/\s([A-Z]{2})$/);
  return m ? m[1] : '—';
}

// Remove o estado do nome para exibição
function primeiroNome(nome) {
  return String(nome || '').replace(/\s+[A-Z]{2}$/, '').trim();
}

// ── componente principal ──────────────────────────────────

export default function FinanceiroDashboard() {
  const { perfil, logout } = useAuth();
  const hoje = new Date();
  const mesAtual = hoje.getMonth() + 1;
  const anoAtual = hoje.getFullYear();

  const [mes, setMes]           = useState(mesAtual);
  const [ano, setAno]           = useState(anoAtual);
  const [dados, setDados]       = useState([]);
  const [filtroEstado, setFiltroEstado] = useState('TODOS');
  const [carregando, setCarregando] = useState(false);
  const [modal, setModal]       = useState(null); // dados do vendedor selecionado
  const [valorPagto, setValorPagto] = useState('');
  const [tipoPagto, setTipoPagto]   = useState('normal');
  const [obs, setObs]               = useState('');
  const [salvando, setSalvando]     = useState(false);
  const [erro, setErro]             = useState('');
  const [deletando, setDeletando]   = useState(null); // id do doc sendo deletado
  const [alertaMeses, setAlertaMeses] = useState([]); // meses anteriores com pendente
  const [historicoVend, setHistoricoVend] = useState({}); // chave → { emAberto, saldo, atrasado }

  const isPassado = ano < anoAtual || (ano === anoAtual && mes < mesAtual);
  const prefixo   = `${ano}-${String(mes).padStart(2, '0')}`;

  useEffect(() => { carregar(); carregarHistorico(); }, [mes, ano]);

  // Verifica meses anteriores com comissão disponível não paga (roda uma vez ao montar)
  useEffect(() => {
    async function verificarAnteriores() {
      const candidatos = [];
      let m = mesAtual, a = anoAtual;
      for (let i = 0; i < 4; i++) {
        m--; if (m < 1) { m = 12; a--; }
        candidatos.push({ mes: m, ano: a, prefixo: `${a}-${String(m).padStart(2, '0')}` });
      }

      const resultado = [];
      for (const { mes: cm, ano: ca, prefixo: pref } of candidatos) {
        try {
          // pedidos do mês
          const snapPed = await getDocs(query(
            collection(db, 'pedidos'),
            where('dataVenda', '>=', `${pref}-01`),
            where('dataVenda', '<=', `${pref}-31`),
          ));
          const pedidos = snapPed.docs.map(d => d.data());
          if (!pedidos.length) continue;

          // financeiro
          const finIds = [...new Set(pedidos.map(extrairFinId).filter(Boolean))];
          const finMap = {};
          if (finIds.length) {
            const lotes = [];
            for (let i = 0; i < finIds.length; i += 30) lotes.push(finIds.slice(i, i + 30));
            const snaps = await Promise.all(
              lotes.map(l => getDocs(query(collection(db, 'financeiro'), where('docId', 'in', l))))
            );
            snaps.forEach(s => s.docs.forEach(d => {
              const r = d.data(); finMap[r.docId] = r.statusGeral || 'EM_ABERTO';
            }));
          }

          // disponível por vendedor
          const grupos = {};
          pedidos.forEach(p => {
            const chave = `${p.vendedor || 'Sem vendedor'}|${String(p.estado || '—').trim().toUpperCase()}`;
            if (!grupos[chave]) grupos[chave] = { disponivel: 0 };
            if ((finMap[extrairFinId(p)] || 'EM_ABERTO') === 'RECEBIDO')
              grupos[chave].disponivel += Number(p.comissao || 0);
          });

          // pagamentos já registrados
          const snapPag = await getDocs(query(
            collection(db, 'pagamentosComissao'), where('mes', '==', pref)
          ));
          const pagos = {};
          snapPag.docs.forEach(d => {
            const p = d.data();
            const chave = `${p.vendedor}|${String(p.estado || '—').trim().toUpperCase()}`;
            pagos[chave] = (pagos[chave] || 0) + Number(p.valor || 0);
          });

          let valorPendente = 0, qtd = 0;
          Object.entries(grupos).forEach(([chave, g]) => {
            const pend = Math.max(0, g.disponivel - (pagos[chave] || 0));
            if (pend > 0.01) { valorPendente += pend; qtd++; }
          });

          if (valorPendente > 0.01) resultado.push({ mes: cm, ano: ca, prefixo: pref, valor: valorPendente, qtd });
        } catch (e) {
          console.error('Erro verificar mês anterior:', pref, e);
        }
      }
      setAlertaMeses(resultado);
    }
    verificarAnteriores();
  }, []);

  async function carregar() {
    setCarregando(true);
    try {
      // 1. Pedidos do mês
      const snapPed = await getDocs(query(
        collection(db, 'pedidos'),
        where('dataVenda', '>=', `${prefixo}-01`),
        where('dataVenda', '<=', `${prefixo}-31`),
      ));
      const pedidos = snapPed.docs.map(d => d.data());

      // 2. Financeiro — para categorizar a comissão por status
      const finIds = [...new Set(pedidos.map(extrairFinId).filter(Boolean))];
      const finMap = {}; // finId → statusGeral
      if (finIds.length) {
        const lotes = [];
        for (let i = 0; i < finIds.length; i += 30) lotes.push(finIds.slice(i, i + 30));
        const snaps = await Promise.all(
          lotes.map(l => getDocs(query(collection(db, 'financeiro'), where('docId', 'in', l))))
        );
        snaps.forEach(s => s.docs.forEach(d => {
          const r = d.data();
          finMap[r.docId] = r.statusGeral || 'EM_ABERTO';
        }));
      }

      // 3. Agrupa por "vendedor|estado" com breakdown por status
      const grupos = {};
      pedidos.forEach((p) => {
        const vend  = p.vendedor || 'Sem vendedor';
        const est   = String(p.estado || '—').trim().toUpperCase();
        const chave = `${vend}|${est}`;
        if (!grupos[chave]) grupos[chave] = {
          vendedor: vend, estado: est,
          gerada: 0, bloqueada: 0, disponivel: 0, emAberto: 0,
        };
        const com    = Number(p.comissao || 0);
        const status = finMap[extrairFinId(p)] || 'EM_ABERTO';
        grupos[chave].gerada += com;
        if      (status === 'ATRASADO')  grupos[chave].bloqueada  += com;
        else if (status === 'RECEBIDO')  grupos[chave].disponivel += com;
        else                             grupos[chave].emAberto   += com;
      });

      // 4. Pagamentos já registrados
      const snapPag = await getDocs(query(
        collection(db, 'pagamentosComissao'),
        where('mes', '==', prefixo),
      ));
      const pagos = {}, historicoPagtos = {};
      snapPag.docs.forEach((d) => {
        const p     = d.data();
        const est   = String(p.estado || '—').trim().toUpperCase();
        const chave = `${p.vendedor}|${est}`;
        pagos[chave] = (pagos[chave] || 0) + Number(p.valor || 0);
        if (!historicoPagtos[chave]) historicoPagtos[chave] = [];
        historicoPagtos[chave].push({
          id:    d.id,
          valor: Number(p.valor || 0),
          data:  p.dataPagamento || '',
          tipo:  p.tipo || 'normal',
          obs:   p.observacao || '',
        });
      });

      // 5. Montar lista — pendente = disponível - pago (o que tem para pagar agora)
      const lista = Object.entries(grupos)
        .map(([chave, g]) => {
          const totalPago = pagos[chave] || 0;
          return {
            chave,
            vendedor:   g.vendedor,
            estado:     g.estado,
            gerada:     g.gerada,
            bloqueada:  g.bloqueada,
            disponivel: g.disponivel,
            emAberto:   g.emAberto,
            totalPago,
            pendente:   Math.max(0, g.disponivel - totalPago),
            // manter totalComissao para compatibilidade com modal
            totalComissao: g.gerada,
            historico:  (historicoPagtos[chave] || []).sort((a, b) => b.data.localeCompare(a.data)),
          };
        })
        .sort((a, b) => a.estado.localeCompare(b.estado) || a.vendedor.localeCompare(b.vendedor));

      setDados(lista);
    } catch (e) {
      console.error(e);
    } finally {
      setCarregando(false);
    }
  }

  async function carregarHistorico() {
    const INICIO_HISTORICO = '2026-05-01';
    const INICIO_ATRASADOS = '2025-01-01';
    const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
    try {
      const snap = await getDocs(query(
        collection(db, 'pedidos'),
        where('dataVenda', '>=', INICIO_ATRASADOS),
        where('dataVenda', '<',  inicio),
      ));
      const pedidosAnt = snap.docs.map(d => d.data());
      if (!pedidosAnt.length) { setHistoricoVend({}); return; }

      const finIds = [...new Set(pedidosAnt.map(extrairFinId).filter(Boolean))];
      const lotes  = [];
      for (let i = 0; i < finIds.length; i += 30) lotes.push(finIds.slice(i, i + 30));
      const snaps  = await Promise.all(
        lotes.map(l => getDocs(query(collection(db, 'financeiro'), where('docId', 'in', l))))
      );
      const finMap = {};
      snaps.forEach(s => s.docs.forEach(d => { const r = d.data(); finMap[r.docId] = r.statusGeral || 'EM_ABERTO'; }));

      const agg = {};
      pedidosAnt.forEach(p => {
        const vend  = p.vendedor || 'Sem vendedor';
        const est   = String(p.estado || '—').trim().toUpperCase();
        const chave = `${vend}|${est}`;
        if (!agg[chave]) agg[chave] = { emAberto: 0, saldo: 0, atrasado: 0 };
        const com    = Number(p.comissao || 0);
        if (!com) return;
        const status = finMap[extrairFinId(p)];
        if (status === 'ATRASADO') {
          agg[chave].atrasado += com;
        } else if ((p.dataVenda || '') >= INICIO_HISTORICO) {
          if (status === 'EM_ABERTO') agg[chave].emAberto += com;
          else                        agg[chave].saldo    += com;
        }
      });
      setHistoricoVend(agg);
    } catch (e) {
      console.error('Erro ao carregar histórico:', e);
    }
  }

  function abrirModal(d) {
    setModal(d);
    // Pré-preenche com o valor pendente
    setValorPagto(d.pendente > 0 ? d.pendente.toFixed(2).replace('.', ',') : '');
    setTipoPagto(isPassado ? 'retroativo' : 'normal');
    setObs('');
    setErro('');
  }

  async function confirmarPagamento() {
    const valor = parseFloat(String(valorPagto).replace(',', '.'));
    if (!modal || isNaN(valor) || valor <= 0) {
      setErro('Informe um valor válido.');
      return;
    }
    setSalvando(true);
    try {
      await addDoc(collection(db, 'pagamentosComissao'), {
        vendedor:      modal.vendedor,
        estado:        modal.estado,
        mes:           prefixo,
        valor,
        dataPagamento: hojeISO(),
        tipo:          tipoPagto,
        observacao:    obs,
        registradoPor: perfil?.email || 'financeiro',
        createdAt:     serverTimestamp(),
      });
      setModal(null);
      await carregar();
    } catch (e) {
      console.error(e);
      setErro('Erro ao salvar. Tente novamente.');
    } finally {
      setSalvando(false);
    }
  }

  async function deletarPagamento(pagtoId) {
    if (!window.confirm('Tem certeza que deseja excluir este pagamento? Essa ação não pode ser desfeita.')) return;
    setDeletando(pagtoId);
    try {
      await deleteDoc(doc(db, 'pagamentosComissao', pagtoId));
      // Atualiza o modal com o histórico sem o item deletado
      setModal(m => m ? {
        ...m,
        historico: m.historico.filter(h => h.id !== pagtoId),
      } : null);
      await carregar();
    } catch (e) {
      console.error(e);
      alert('Erro ao excluir pagamento. Tente novamente.');
    } finally {
      setDeletando(null);
    }
  }

  // Estados disponíveis nos dados
  const estadosDisponiveis = ['TODOS', ...[...new Set(dados.map((d) => d.estado).filter((e) => e && e !== '—'))].sort()];
  const dadosFiltrados = filtroEstado === 'TODOS' ? dados : dados.filter((d) => d.estado === filtroEstado);

  const totalGerada    = dadosFiltrados.reduce((s, d) => s + d.gerada,     0);
  const totalBloqueada = dadosFiltrados.reduce((s, d) => s + d.bloqueada,  0);
  const totalDisponivel= dadosFiltrados.reduce((s, d) => s + d.disponivel, 0);
  const totalPago      = dadosFiltrados.reduce((s, d) => s + d.totalPago,  0);
  const totalPendente  = dadosFiltrados.reduce((s, d) => s + d.pendente,   0);
  const qtdPendentes   = dadosFiltrados.filter((d) => d.pendente > 0.01).length;
  // mantém compatibilidade
  const totalComissao  = totalGerada;

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>

      {/* Header */}
      <div style={{ background: '#0f3460', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Financeiro</p>
          <h1 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#fff' }}>Pagamentos de Comissão</h1>
        </div>
        <button onClick={logout} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
          Sair
        </button>
      </div>

      {/* Seletor de mês + filtro por estado */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '12px 16px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={mes} onChange={(e) => setMes(Number(e.target.value))} style={st.select}>
          {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={ano} onChange={(e) => setAno(Number(e.target.value))} style={st.select}>
          {[anoAtual, anoAtual - 1, anoAtual - 2].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        {/* Filtros de estado / conta */}
        <div style={{ display: 'flex', gap: '4px', marginLeft: '4px' }}>
          {estadosDisponiveis.map((e) => (
            <button key={e} onClick={() => setFiltroEstado(e)} style={{
              padding: '5px 12px', borderRadius: '20px', border: 'none', cursor: 'pointer',
              fontWeight: '700', fontSize: '12px',
              background: filtroEstado === e ? '#0f3460' : '#f1f5f9',
              color:      filtroEstado === e ? '#fff'    : '#6b7280',
            }}>
              {e === 'TODOS' ? 'Todos' : e}
            </button>
          ))}
        </div>
        {isPassado
          ? <span style={{ fontSize: '12px', fontWeight: '700', color: '#d97706', background: '#fef3c7', padding: '4px 12px', borderRadius: '20px' }}>📋 Mês anterior — possíveis retroativos</span>
          : <span style={{ fontSize: '12px', color: '#6b7280' }}>Próxima segunda: <strong>{proximaSegunda()}</strong></span>
        }
      </div>

      {/* Alertas de meses anteriores com pendente */}
      {alertaMeses.length > 0 && (
        <div style={{ background: '#fef9c3', borderBottom: '1px solid #fde68a', padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '12px', fontWeight: '800', color: '#92400e' }}>⚠️ Pagamentos pendentes de meses anteriores</span>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {alertaMeses.map(({ mes: cm, ano: ca, prefixo: pref, valor, qtd }) => (
              <button
                key={pref}
                onClick={() => { setMes(cm); setAno(ca); }}
                style={{
                  background: '#fff', border: '1px solid #f59e0b', borderRadius: '20px',
                  padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
                  color: '#92400e', fontWeight: '700', display: 'flex', gap: '6px', alignItems: 'center',
                }}
              >
                {MESES[cm - 1]} {ca}
                <span style={{ background: '#fef3c7', borderRadius: '10px', padding: '1px 7px', fontSize: '11px' }}>
                  {qtd} vendedor{qtd > 1 ? 'es' : ''} · {moeda(valor)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: '16px', maxWidth: '640px', margin: '0 auto' }}>

        {carregando ? (
          <p style={{ textAlign: 'center', color: '#6b7280', padding: '60px 0' }}>Carregando...</p>
        ) : (
          <>
            {/* Card resumo */}
            <div style={{ background: '#0f3460', borderRadius: '14px', padding: '20px', marginBottom: '16px', color: '#fff' }}>
              <p style={{ margin: '0 0 2px', fontSize: '12px', color: '#94a3b8' }}>
                {isPassado ? 'Total retroativo pendente' : 'Total a pagar esta semana'}
              </p>
              <p style={{ margin: '0 0 14px', fontSize: '28px', fontWeight: '800' }}>{moeda(totalPendente)}</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px 20px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8' }}>Gerada</p>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: '700' }}>{moeda(totalGerada)}</p>
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: '11px', color: '#f87171' }}>🔒 Bloqueada</p>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#f87171' }}>{moeda(totalBloqueada)}</p>
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: '11px', color: '#6ee7b7' }}>✓ Disponível</p>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#6ee7b7' }}>{moeda(totalDisponivel)}</p>
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: '11px', color: '#4ade80' }}>Paga</p>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#4ade80' }}>{moeda(totalPago)}</p>
                </div>
              </div>
              {qtdPendentes > 0 && (
                <p style={{ margin: '12px 0 0', fontSize: '12px', color: '#fbbf24' }}>
                  {qtdPendentes} vendedor{qtdPendentes > 1 ? 'es' : ''} com pagamento pendente
                </p>
              )}
            </div>

            {/* Lista de vendedores */}
            {dadosFiltrados.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#6b7280', padding: '40px' }}>Nenhuma comissão encontrada para este filtro.</p>
            ) : (
              dadosFiltrados.map((d) => (
                <CartaoVendedor key={d.chave} dados={d} isPassado={isPassado} historico={historicoVend[d.chave] || null} onPagar={() => abrirModal(d)} onDeletar={deletarPagamento} deletando={deletando} />
              ))
            )}
          </>
        )}
      </div>

      {/* Modal de pagamento */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '420px' }}>
            <h2 style={{ margin: '0 0 2px', fontSize: '18px', fontWeight: '800' }}>Registrar Pagamento</h2>
            <p style={{ margin: '0 0 18px', color: '#6b7280', fontSize: '14px' }}>
              {modal.vendedor}
              {modal.estado && modal.estado !== '—' && (
                <span style={{ marginLeft: '6px', fontWeight: '700', color: '#0f3460', background: '#e0e7ff', padding: '1px 7px', borderRadius: '10px', fontSize: '12px' }}>{modal.estado}</span>
              )}
              {' — '}{MESES[mes - 1]} {ano}
            </p>

            {/* Resumo */}
            <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '14px', marginBottom: '16px' }}>
              <Row label="Comissão do mês"  valor={moeda(modal.totalComissao)} />
              <Row label="Já pago"          valor={moeda(modal.totalPago)}    cor="#16a34a" />
              <div style={{ borderTop: '1px solid #e5e7eb', marginTop: '8px', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: '700', fontSize: '14px' }}>Pendente</span>
                <span style={{ fontWeight: '800', fontSize: '14px', color: '#0f3460' }}>{moeda(modal.pendente)}</span>
              </div>
            </div>

            {/* Histórico de pagamentos do mês */}
            {modal.historico.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <p style={st.label}>Pagamentos anteriores neste mês</p>
                {modal.historico.map((h, i) => (
                  <div key={h.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', padding: '6px 0', borderBottom: i < modal.historico.length - 1 ? '1px solid #f3f4f6' : 'none', gap: '8px' }}>
                    <span style={{ color: '#6b7280', flex: 1 }}>{h.data.split('-').reverse().join('/')} · <span style={{ color: h.tipo === 'retroativo' ? '#d97706' : '#2563eb', fontWeight: '600' }}>{h.tipo}</span>{h.obs ? ` · ${h.obs}` : ''}</span>
                    <span style={{ fontWeight: '700', color: '#16a34a', whiteSpace: 'nowrap' }}>{moeda(h.valor)}</span>
                    <button
                      onClick={() => deletarPagamento(h.id)}
                      disabled={deletando === h.id}
                      title="Excluir pagamento"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '2px 4px', fontSize: '14px', lineHeight: 1, opacity: deletando === h.id ? 0.4 : 1, flexShrink: 0 }}
                    >
                      {deletando === h.id ? '…' : '🗑'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Campos */}
            <p style={st.label}>Valor a pagar (R$)</p>
            <input
              value={valorPagto}
              onChange={(e) => { setValorPagto(e.target.value); setErro(''); }}
              style={{ ...st.input, fontSize: '20px', fontWeight: '700', marginBottom: '12px' }}
              placeholder="0,00"
            />

            <p style={st.label}>Tipo de pagamento</p>
            <select value={tipoPagto} onChange={(e) => setTipoPagto(e.target.value)} style={{ ...st.input, marginBottom: '12px' }}>
              <option value="normal">Normal (semana corrente)</option>
              <option value="retroativo">Retroativo (referente a mês anterior)</option>
            </select>

            <p style={st.label}>Observação (opcional)</p>
            <input
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              style={{ ...st.input, marginBottom: erro ? '6px' : '20px' }}
              placeholder="Ex: pagamento parcial, acerto de boleto X..."
            />
            {erro && <p style={{ margin: '0 0 14px', fontSize: '12px', color: '#dc2626' }}>{erro}</p>}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setModal(null)}
                style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontWeight: '600', fontSize: '14px' }}
              >
                Cancelar
              </button>
              <button
                onClick={confirmarPagamento}
                disabled={salvando}
                style={{ flex: 2, padding: '12px', borderRadius: '8px', border: 'none', background: '#0f3460', color: '#fff', cursor: 'pointer', fontWeight: '700', fontSize: '14px', opacity: salvando ? 0.7 : 1 }}
              >
                {salvando ? 'Salvando...' : '✓ Confirmar Pagamento'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── cartão por vendedor ───────────────────────────────────

function CartaoVendedor({ dados, isPassado, historico, onPagar, onDeletar, deletando }) {
  const [aberto, setAberto] = useState(false);
  const pct    = dados.totalComissao > 0 ? (dados.totalPago / dados.totalComissao) * 100 : 0;
  const pago   = dados.pendente < 0.01;
  const estado = dados.estado && dados.estado !== '—' ? dados.estado : null;
  const temHistorico = historico && (historico.emAberto > 0.01 || historico.saldo > 0.01 || historico.atrasado > 0.01);

  return (
    <div style={{ background: '#fff', borderRadius: '12px', marginBottom: '10px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <div style={{ padding: '14px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Nome + badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <span style={{ fontWeight: '700', fontSize: '15px', color: '#111827' }}>{dados.vendedor}</span>
            {estado && (
              <span style={{ fontSize: '11px', fontWeight: '800', color: '#fff', background: '#0f3460', padding: '2px 8px', borderRadius: '20px' }}>
                {estado}
              </span>
            )}
            {pago && <span style={{ fontSize: '11px', fontWeight: '700', color: '#16a34a', background: '#dcfce7', padding: '2px 8px', borderRadius: '20px' }}>✓ Pago</span>}
            {isPassado && !pago && <span style={{ fontSize: '11px', fontWeight: '700', color: '#d97706', background: '#fef3c7', padding: '2px 8px', borderRadius: '20px' }}>Retroativo</span>}
          </div>

          {/* Barra de progresso */}
          <div style={{ height: '6px', background: '#f1f5f9', borderRadius: '3px', marginBottom: '8px' }}>
            <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: pago ? '#16a34a' : '#0f3460', borderRadius: '3px', transition: 'width 0.4s' }} />
          </div>

          {/* Valores — 4 campos em grid 2×2 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
            <span style={{ fontSize: '12px', color: '#6b7280' }}>
              Gerada: <strong style={{ color: '#111827' }}>{moeda(dados.gerada)}</strong>
            </span>
            <span style={{ fontSize: '12px', color: '#dc2626' }}>
              🔒 Bloqueada: <strong>{moeda(dados.bloqueada)}</strong>
            </span>
            <span style={{ fontSize: '12px', color: '#0369a1' }}>
              Disponível: <strong>{moeda(dados.disponivel)}</strong>
            </span>
            <span style={{ fontSize: '12px', color: '#16a34a' }}>
              Paga: <strong>{moeda(dados.totalPago)}</strong>
            </span>
          </div>
          {!pago && dados.pendente > 0 && (
            <div style={{ marginTop: '6px', padding: '4px 10px', background: '#eff6ff', borderRadius: '6px', display: 'inline-block' }}>
              <span style={{ fontSize: '12px', fontWeight: '700', color: '#1d4ed8' }}>
                A pagar: {moeda(dados.pendente)}
              </span>
            </div>
          )}

          {/* Meses anteriores */}
          {temHistorico && (
            <div style={{ marginTop: '8px', borderTop: '1px solid #f3f4f6', paddingTop: '8px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: '800', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Meses ant.</span>
              {historico.emAberto > 0.01 && (
                <span style={{ fontSize: '11px', color: '#6b7280' }}>
                  Em aberto: <strong style={{ color: '#374151' }}>{moeda(historico.emAberto)}</strong>
                </span>
              )}
              {historico.saldo > 0.01 && (
                <span style={{ fontSize: '11px', color: '#6b7280' }}>
                  Saldo: <strong style={{ color: '#16a34a' }}>{moeda(historico.saldo)}</strong>
                </span>
              )}
              {historico.atrasado > 0.01 && (
                <span style={{ fontSize: '11px', color: '#dc2626', fontWeight: '700', background: '#fee2e2', padding: '1px 7px', borderRadius: '20px' }}>
                  🔒 Atrasado: {moeda(historico.atrasado)}
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
          {!pago && (
            <button onClick={onPagar} style={{ padding: '8px 14px', background: '#0f3460', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: '700', fontSize: '13px', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <PixIcon size={16} /> Pagar
            </button>
          )}
          {dados.historico.length > 0 && (
            <button onClick={() => setAberto((v) => !v)} style={{ background: 'transparent', border: 'none', color: '#9ca3af', fontSize: '12px', cursor: 'pointer', padding: '2px' }}>
              {aberto ? '▲ ocultar' : `▼ ${dados.historico.length} pagamento(s)`}
            </button>
          )}
        </div>
      </div>

      {/* Histórico expansível */}
      {aberto && dados.historico.length > 0 && (
        <div style={{ background: '#f8fafc', borderTop: '1px solid #e5e7eb', padding: '10px 14px' }}>
          {dados.historico.map((h, i) => (
            <div key={h.id || i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '5px 0', borderBottom: i < dados.historico.length - 1 ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ color: '#6b7280', flex: 1 }}>
                {h.data.split('-').reverse().join('/')}
                {' · '}
                <span style={{ color: h.tipo === 'retroativo' ? '#d97706' : '#2563eb', fontWeight: '600' }}>{h.tipo}</span>
                {h.obs ? ` · ${h.obs}` : ''}
              </span>
              <span style={{ fontWeight: '700', color: '#16a34a', whiteSpace: 'nowrap' }}>{moeda(h.valor)}</span>
              <button
                onClick={() => onDeletar(h.id)}
                disabled={deletando === h.id}
                title="Excluir pagamento"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '2px 4px', fontSize: '14px', lineHeight: 1, opacity: deletando === h.id ? 0.4 : 1, flexShrink: 0 }}
              >
                {deletando === h.id ? '…' : '🗑'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ícone Pix ────────────────────────────────────────────

function PixIcon({ size = 18, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill={color} xmlns="http://www.w3.org/2000/svg">
      <path d="M242.269 4.394a19.504 19.504 0 0 0-13.834 5.726L174.73 63.826a9.775 9.775 0 0 1-6.917 2.862h-22.91c-7.21 0-14.122 2.863-19.215 7.955l-80.82 80.822c-10.608 10.608-10.608 27.805 0 38.411l80.82 80.82c5.093 5.094 12.005 7.957 19.215 7.957h22.91c2.608 0 5.097 1.036 6.917 2.86l53.704 53.706a19.501 19.501 0 0 0 13.834 5.726 19.5 19.5 0 0 0 13.834-5.726l53.706-53.706a9.77 9.77 0 0 1 6.915-2.86h22.91c7.21 0 14.122-2.863 19.215-7.957l80.82-80.82c10.608-10.606 10.608-27.803 0-38.411l-80.82-80.822c-5.093-5.092-12.005-7.955-19.215-7.955h-22.91a9.775 9.775 0 0 1-6.915-2.862L256.103 10.12a19.5 19.5 0 0 0-13.834-5.726zm0 38.45 44.024 44.024a49.292 49.292 0 0 0 34.902 14.462h22.91l63.606 63.607-63.607 63.607h-22.91c-13.1 0-25.634 5.204-34.9 14.462l-44.025 44.024-44.023-44.024a49.301 49.301 0 0 0-34.904-14.462h-22.91l-63.607-63.607 63.607-63.607h22.91c13.1 0 25.636-5.204 34.904-14.462z"/>
    </svg>
  );
}

// ── helpers de UI ─────────────────────────────────────────

function Row({ label, valor, cor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
      <span style={{ fontSize: '13px', color: '#6b7280' }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: '600', color: cor || '#111827' }}>{valor}</span>
    </div>
  );
}

// ── estilos ───────────────────────────────────────────────

const st = {
  select: {
    padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: '7px',
    fontSize: '13px', background: '#fff', cursor: 'pointer',
  },
  input: {
    width: '100%', padding: '10px 12px', border: '1.5px solid #e5e7eb',
    borderRadius: '8px', fontSize: '14px', outline: 'none', display: 'block',
  },
  label: {
    margin: '0 0 6px', fontSize: '11px', fontWeight: '700', color: '#374151',
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
};

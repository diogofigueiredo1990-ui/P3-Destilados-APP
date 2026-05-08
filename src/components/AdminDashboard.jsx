import { useEffect, useState } from 'react';
import { collection, query, where, getDocs, documentId, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import { diasUteisNoMes, diasUteisPassados } from '../utils/data';
import VendedorDashboard from './VendedorDashboard';
import MetaCard from './MetaCard';
import GraficoVendasMensais from './GraficoVendasMensais';
import GestaoUsuarios from './GestaoUsuarios';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea, ResponsiveContainer } from 'recharts';

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

function moeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Remove o sufixo de estado do nome do vendedor (ex: "Diogo MG" → "Diogo")
function normalizarVendedor(nome) {
  return String(nome || '').replace(/\s+[A-Z]{2}$/, '').trim();
}

function TooltipProspeccao({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const fechamento = d.x >= 5 && d.y >= 6;
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}>
      <p style={{ margin: '0 0 6px', fontWeight: '700', color: '#111827', fontSize: '13px' }}>{d.label}</p>
      <p style={{ margin: '0 0 2px', color: '#6b7280' }}>Visitas: <strong>{d.x}</strong></p>
      <p style={{ margin: 0, color: '#6b7280' }}>Satisfação média: <strong>{d.y}</strong></p>
      {fechamento && <p style={{ margin: '6px 0 0', color: '#15803d', fontWeight: '700', fontSize: '11px' }}>✅ Alta probabilidade de fechamento</p>}
    </div>
  );
}

function PontoProspecto({ cx, cy, payload }) {
  const closing = payload.x >= 5 && payload.y >= 6;
  const nome    = String(payload.label || '');
  const short   = nome.length > 15 ? nome.slice(0, 15) + '…' : nome;
  return (
    <g>
      <circle cx={cx} cy={cy} r={7} fill={closing ? '#16a34a' : '#0f3460'} stroke="#fff" strokeWidth={2} opacity={0.9} />
      <text x={cx} y={cy - 11} textAnchor="middle" fontSize={9} fill={closing ? '#15803d' : '#374151'} fontWeight="600">{short}</text>
    </g>
  );
}

function GraficoProspeccao({ dados }) {
  const emFechamento = dados.filter(d => d.x >= 5 && d.y >= 6).length;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <p style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#111827' }}>🎯 Gráfico de Prospecção</p>
        <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
          <span style={{ color: '#6b7280' }}><strong>{dados.length}</strong> prospectos</span>
          <span style={{ color: '#15803d', fontWeight: '700' }}><strong>{emFechamento}</strong> em fechamento</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={440}>
        <ScatterChart margin={{ top: 24, right: 40, bottom: 52, left: 20 }}>
          {/* Quadrante de fechamento — fundo verde */}
          <ReferenceArea x1={5} x2={10} y1={6} y2={10} fill="#dcfce7" fillOpacity={0.55} />

          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />

          <XAxis
            type="number" dataKey="x"
            domain={[0, 10]} ticks={[0,1,2,3,4,5,6,7,8,9,10]}
            tick={{ fontSize: 11, fill: '#6b7280' }}
            label={{ value: 'Quantidade de Visitas', position: 'insideBottom', offset: -34, fontSize: 12, fill: '#6b7280' }}
          />
          <YAxis
            type="number" dataKey="y"
            domain={[0, 10]} ticks={[0,1,2,3,4,5,6,7,8,9,10]}
            tick={{ fontSize: 11, fill: '#6b7280' }}
            label={{ value: 'Satisfação Média', angle: -90, position: 'insideLeft', offset: 16, fontSize: 12, fill: '#6b7280' }}
          />

          {/* Linhas divisórias dos quadrantes */}
          <ReferenceLine x={5} stroke="#9ca3af" strokeDasharray="5 3" strokeWidth={1.5} label={{ value: 'mín. 5 visitas', position: 'top', fontSize: 10, fill: '#9ca3af' }} />
          <ReferenceLine y={6} stroke="#9ca3af" strokeDasharray="5 3" strokeWidth={1.5} label={{ value: 'satisf. ≥ 6', position: 'right', fontSize: 10, fill: '#9ca3af' }} />

          <Tooltip content={<TooltipProspeccao />} cursor={false} />
          <Scatter data={dados} shape={<PontoProspecto />} />
        </ScatterChart>
      </ResponsiveContainer>

      <p style={{ margin: '-12px 0 0', textAlign: 'center', fontSize: '11px', color: '#15803d', fontWeight: '600' }}>
        Quadrante de fechamento — ≥ 5 visitas · satisfação ≥ 6
      </p>
    </div>
  );
}

export default function AdminDashboard() {
  const { logout, usuario } = useAuth();
  const hoje = new Date();
  const [mes, setMes] = useState(hoje.getMonth() + 1);
  const [ano, setAno] = useState(hoje.getFullYear());
  const [resumo, setResumo] = useState([]);
  const [erroQuery, setErroQuery] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [vendedorSelecionado, setVendedorSelecionado] = useState(null);
  const [abaMetas, setAbaMetas] = useState(false);
  const [abaUsuarios, setAbaUsuarios] = useState(false);
  const [abaReuniao, setAbaReuniao] = useState(false);
  const [vendedorReuniao, setVendedorReuniao]     = useState('');
  const [dadosGrafico, setDadosGrafico]           = useState(null);
  const [carregandoGrafico, setCarregandoGrafico] = useState(false);
  const [abaInicialVendedor, setAbaInicialVendedor] = useState('hoje');

  // Compromissos da reunião
  const [compInsights, setCompInsights] = useState({ texto: '', valor: '' });
  const [compDiario,   setCompDiario]   = useState({ texto: '', valor: '' });
  const [compClientes, setCompClientes] = useState({ texto: '', valor: '', atrasos: '' });
  const [salvandoComp, setSalvandoComp] = useState({});
  const [compSalvos,   setCompSalvos]   = useState([]);   // acumulados para o PDF
  const [metasAnteriores, setMetasAnteriores] = useState({}); // { insights: doc, diario: doc, clientes: doc }
  const [avaliacoes, setAvaliacoes] = useState({ insights: null, diario: null, clientes: null });

  // Feedback
  const [showFeedback,     setShowFeedback]     = useState(false);
  const [feedback,         setFeedback]         = useState({ positivo: '', negativo: '', comentarios: '' });
  const [salvandoFeedback, setSalvandoFeedback] = useState(false);
  const [feedbackSalvo,    setFeedbackSalvo]    = useState(null);

  // Transcrição + PDF
  const [showTranscricao, setShowTranscricao] = useState(false);
  const [transcricao,     setTranscricao]     = useState('');

  const anos = [];
  for (let a = hoje.getFullYear(); a >= hoje.getFullYear() - 3; a--) anos.push(a);

  useEffect(() => {
    async function buscar() {
      setCarregando(true);
      setErroQuery(null);
      try {
        const prefixo = `${ano}-${String(mes).padStart(2, '0')}`;

        // Carrega pedidos do mês E todos os usuários vendedores em paralelo
        const [snap, snapUsuarios] = await Promise.all([
          getDocs(query(
            collection(db, 'pedidos'),
            where('dataVenda', '>=', `${prefixo}-01`),
            where('dataVenda', '<=', `${prefixo}-31`)
          )),
          getDocs(query(
            collection(db, 'usuarios'),
            where('perfil', '==', 'vendedor'),
          )),
        ]);

        // Inicializa o mapa com TODOS os vendedores ativos (mesmo sem vendas no mês)
        const mapa = {};
        snapUsuarios.docs.forEach(d => {
          const u = d.data();
          if (u.ativo === false) return; // ignora desativados
          const v = normalizarVendedor(u.vendedor);
          if (!v) return;
          mapa[v] = { vendedor: v, faturamento: 0, comissao: 0, vendas: new Set(), produtos: 0 };
        });

        // Soma pedidos do mês
        const pedidos = snap.docs.map((d) => d.data());
        for (const p of pedidos) {
          const v = normalizarVendedor(p.vendedor) || 'Sem vendedor';
          if (!mapa[v]) mapa[v] = { vendedor: v, faturamento: 0, comissao: 0, vendas: new Set(), produtos: 0 };
          mapa[v].faturamento += Number(p.faturamento || 0);
          mapa[v].comissao    += Number(p.comissao    || 0);
          mapa[v].produtos    += 1;
          const chave = p.chave || '';
          const partes = chave.split('_');
          const vendaId = partes.length >= 2 ? `${p.contaAzul}_${partes[1]}` : chave;
          if (vendaId) mapa[v].vendas.add(vendaId);
        }

        // Converte Set em número e ordena: quem vendeu primeiro, depois sem vendas
        for (const v in mapa) mapa[v].vendas = mapa[v].vendas.size;

        const lista = Object.values(mapa).sort((a, b) => {
          if (b.comissao !== a.comissao) return b.comissao - a.comissao;
          return a.vendedor.localeCompare(b.vendedor);
        });
        setResumo(lista);
      } catch (err) {
        console.error('AdminDashboard query error:', err);
        setErroQuery(err?.message || String(err));
      } finally {
        setCarregando(false);
      }
    }
    buscar();
  }, [mes, ano]);

  // Carrega a meta mais recente por tipo quando o vendedor é selecionado
  useEffect(() => {
    if (!vendedorReuniao) {
      setMetasAnteriores({});
      setAvaliacoes({ insights: null, diario: null, clientes: null });
      return;
    }
    async function buscarMetas() {
      try {
        const snap = await getDocs(query(
          collection(db, 'compromissos'),
          where('vendedor', '==', vendedorReuniao)
        ));
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        docs.sort((a, b) => (b.dataReuniao || '').localeCompare(a.dataReuniao || ''));
        const latest = {};
        docs.forEach(d => { if (!latest[d.tipo]) latest[d.tipo] = d; });
        setMetasAnteriores(latest);
      } catch (err) { console.error(err); }
    }
    buscarMetas();
  }, [vendedorReuniao]);

  useEffect(() => {
    if (!vendedorReuniao) { setDadosGrafico(null); return; }
    setCarregandoGrafico(true);
    setDadosGrafico(null);
    async function buscarProspeccao() {
      try {
        // Slug igual ao sistema externo: lowercase + underscores, sem normalizar acentos
        const slugSimples   = vendedorReuniao.toLowerCase().replace(/\s+/g, '_');
        const slugSemEstado = vendedorReuniao.replace(/\s+[A-Z]{2}$/, '').trim()
                                             .toLowerCase().replace(/\s+/g, '_');

        const _allVisDocs = await getDocs(collection(db, 'relatorioVisitas'));
        const snap = { docs: _allVisDocs.docs.filter(d =>
          d.id.startsWith(slugSimples + '_') ||
          d.id.startsWith(slugSemEstado + '_') ||
          String(d.data().vendedor || '').toLowerCase() === slugSimples ||
          String(d.data().vendedor || '').toLowerCase() === slugSemEstado
        )};

        // Somente prospectos: registros SEM CNPJ informado
        // Agrupa por empresa (nome), conta linhas ignorando campo qtdVisitas
        const grupos = {};
        snap.docs.forEach(d => {
          const r    = d.data();
          const cnpj = String(r.cnpj || '').replace(/\D/g, '');
          if (cnpj) return; // tem CNPJ → já é cliente, exclui
          const key = String(r.empresa || '').trim();
          if (!key) return;
          if (!grupos[key]) grupos[key] = { empresa: key, satisfacoes: [], count: 0 };
          grupos[key].count++;
          const sat = Number(r.satisfacao);
          if (!isNaN(sat) && sat > 0) grupos[key].satisfacoes.push(sat);
        });

        const pontos = Object.values(grupos)
          .filter(g => g.satisfacoes.length > 0)
          .map(g => ({
            label: g.empresa,
            x: Math.min(g.count, 10),
            y: Number((g.satisfacoes.reduce((a, b) => a + b, 0) / g.satisfacoes.length).toFixed(1)),
          }));

        setDadosGrafico(pontos);
      } catch (err) {
        console.error('Erro prospecção:', err);
        setDadosGrafico([]);
      } finally {
        setCarregandoGrafico(false);
      }
    }
    buscarProspeccao();
  }, [vendedorReuniao]);

  async function registrarCompromisso(tipo, dados, onReset) {
    setSalvandoComp(p => ({ ...p, [tipo]: true }));
    try {
      const dataHoje = new Date().toISOString().slice(0, 10);
      const anterior = metasAnteriores[tipo];
      // Registra avaliação da meta anterior, se houver
      if (anterior?.id && avaliacoes[tipo] !== null) {
        await updateDoc(doc(db, 'compromissos', anterior.id), { atingida: avaliacoes[tipo] });
      }
      // Cria nova meta acordada
      const novaRef = await addDoc(collection(db, 'compromissos'), {
        vendedor: vendedorReuniao, tipo, ...dados,
        dataReuniao: dataHoje, atingida: null, criadoEm: serverTimestamp(),
      });
      const novaDoc = { id: novaRef.id, vendedor: vendedorReuniao, tipo, ...dados, dataReuniao: dataHoje, atingida: null };
      setMetasAnteriores(prev => ({ ...prev, [tipo]: novaDoc }));
      setAvaliacoes(prev => ({ ...prev, [tipo]: null }));
      setCompSalvos(p => [...p, { tipo, ...dados, atingida: avaliacoes[tipo] }]);
      onReset();
    } catch (err) { console.error(err); }
    finally { setSalvandoComp(p => ({ ...p, [tipo]: false })); }
  }

  async function salvarFeedback() {
    setSalvandoFeedback(true);
    try {
      const dataHoje = new Date().toISOString().slice(0, 10);
      await addDoc(collection(db, 'feedbackVendedor'), {
        vendedor: vendedorReuniao, ...feedback,
        dataReuniao: dataHoje, criadoEm: serverTimestamp(),
      });
      setFeedbackSalvo({ ...feedback });
      setFeedback({ positivo: '', negativo: '', comentarios: '' });
      setShowFeedback(false);
    } catch (err) { console.error(err); }
    finally { setSalvandoFeedback(false); }
  }

  function gerarPDF() {
    const nome  = normalizarVendedor(vendedorReuniao);
    const data  = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const tipoLabel = { insights: 'Insights Individual', diario: 'Diário de Visitas', clientes: 'Gestão de Clientes' };
    const fb = feedbackSalvo;

    // ── Narrativa automática do resumo executivo ──────────────────
    const totalMetas   = compSalvos.length;
    const atingidas    = compSalvos.filter(c => c.atingida === true).length;
    const naoAtingidas = compSalvos.filter(c => c.atingida === false).length;
    const semAvaliacao = compSalvos.filter(c => c.atingida === null).length;

    let narrativa = `Esta ata registra a reunião semanal de acompanhamento realizada com <strong>${nome}</strong> em ${data}.`;

    if (totalMetas > 0) {
      if (naoAtingidas === 0 && atingidas > 0) {
        narrativa += ` Todas as ${atingidas} meta(s) da semana anterior foram atingidas — resultado positivo que demonstra comprometimento e execução.`;
      } else if (atingidas === 0 && naoAtingidas > 0) {
        narrativa += ` Das ${totalMetas} meta(s) avaliadas, nenhuma foi atingida, o que exige atenção especial e revisão das prioridades.`;
      } else if (atingidas > 0 && naoAtingidas > 0) {
        narrativa += ` Das ${totalMetas} meta(s) avaliadas, ${atingidas} fo${atingidas > 1 ? 'ram' : 'i'} atingida(s) e ${naoAtingidas} não fo${naoAtingidas > 1 ? 'ram' : 'i'}, indicando progresso parcial.`;
      } else if (semAvaliacao > 0) {
        narrativa += ` ${totalMetas} nova(s) meta(s) fo${totalMetas > 1 ? 'ram' : 'i'} acordada(s) para a próxima semana.`;
      }
    } else {
      narrativa += ` Nenhuma meta foi registrada nesta reunião.`;
    }

    if (fb?.positivo) narrativa += ` O gestor destacou como ponto positivo: <em>"${fb.positivo}"</em>.`;
    if (fb?.negativo) narrativa += ` Como ponto de atenção: <em>"${fb.negativo}"</em>.`;

    const areasAcordadas = [...new Set(compSalvos.map(c => tipoLabel[c.tipo] || c.tipo))];
    if (areasAcordadas.length > 0) {
      narrativa += ` As novas metas foram acordadas nas áreas de ${areasAcordadas.join(', ')}.`;
    }

    // ── Tabela de balanço (metas anteriores avaliadas nesta reunião) ──
    const metasAvaliadas = compSalvos.filter(c => c.atingida !== null);
    const tabelaBalanco = metasAvaliadas.length > 0
      ? `<table>
          <thead><tr><th>Área</th><th>Meta da semana anterior</th><th>Valor</th><th>Resultado</th></tr></thead>
          <tbody>${metasAvaliadas.map(c => {
            const anterior = metasAnteriores[c.tipo];
            const textoAnt = anterior?.texto || '—';
            const res = c.atingida === true
              ? '<span style="color:#15803d;font-weight:700">✅ Atingida</span>'
              : '<span style="color:#b91c1c;font-weight:700">❌ Não atingida</span>';
            return `<tr><td>${tipoLabel[c.tipo] || c.tipo}</td><td>${textoAnt}</td><td>${anterior?.valor ? 'R$ ' + Number(anterior.valor).toLocaleString('pt-BR') : '—'}</td><td>${res}</td></tr>`;
          }).join('')}</tbody>
        </table>`
      : '<p style="color:#9ca3af;font-style:italic">Nenhuma meta anterior avaliada nesta reunião.</p>';

    // ── Tabela de novas metas ──
    const tabelaNovas = compSalvos.length > 0
      ? `<table>
          <thead><tr><th>Área</th><th>Meta acordada</th><th>Valor</th>${compSalvos.some(c => c.atrasos) ? '<th>Atrasos</th>' : ''}</tr></thead>
          <tbody>${compSalvos.map(c =>
            `<tr><td>${tipoLabel[c.tipo] || c.tipo}</td><td>${c.texto || '—'}</td><td>${c.valor ? 'R$ ' + Number(c.valor).toLocaleString('pt-BR') : '—'}</td>${compSalvos.some(cc => cc.atrasos) ? `<td>${c.atrasos ? 'R$ ' + Number(c.atrasos).toLocaleString('pt-BR') : '—'}</td>` : ''}</tr>`
          ).join('')}</tbody>
        </table>`
      : '<p style="color:#9ca3af;font-style:italic">Nenhuma meta registrada.</p>';

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
      <title>Reunião — ${nome} · ${new Date().toLocaleDateString('pt-BR')}</title>
      <style>
        *{box-sizing:border-box}
        body{font-family:'Segoe UI',Arial,sans-serif;padding:48px;color:#111827;max-width:820px;margin:0 auto;font-size:14px;line-height:1.6}
        h1{color:#0f3460;font-size:22px;margin:0 0 4px;border-bottom:3px solid #0f3460;padding-bottom:12px}
        .subtitulo{color:#6b7280;font-size:13px;margin:0 0 28px}
        h2{color:#0f3460;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb}
        .resumo{background:#f0f7ff;border-left:4px solid #3b82f6;padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:8px;font-size:13.5px;line-height:1.7;color:#1e3a5f}
        table{width:100%;border-collapse:collapse;margin-top:6px}
        th{background:#f8fafc;text-align:left;padding:9px 12px;font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;border-bottom:2px solid #e5e7eb}
        td{padding:9px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;vertical-align:top}
        .positivo{color:#15803d;font-weight:700}.negativo{color:#b91c1c;font-weight:700}
        .feedback-box{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px}
        .fb-card{padding:12px 14px;border-radius:8px;font-size:13px}
        .fb-card.pos{background:#f0fdf4;border:1px solid #bbf7d0}
        .fb-card.neg{background:#fff7ed;border:1px solid #fed7aa}
        .fb-title{font-weight:800;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em}
        .transcricao{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;font-size:12.5px;white-space:pre-wrap;line-height:1.7;color:#374151;max-height:none}
        .rodape{margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center}
        @media print{body{padding:24px}.rodape{position:fixed;bottom:16px;left:0;right:0}}
      </style></head><body>
      <h1>📋 Reunião Semanal de Acompanhamento</h1>
      <p class="subtitulo"><strong>${nome}</strong> &nbsp;·&nbsp; ${data}</p>

      <h2>Resumo Executivo</h2>
      <div class="resumo">${narrativa}</div>

      <h2>Balanço da Semana Anterior</h2>
      ${tabelaBalanco}

      <h2>Metas Acordadas para Esta Semana</h2>
      ${tabelaNovas}

      ${fb ? `
      <h2>Feedback do Gestor</h2>
      <div class="feedback-box">
        <div class="fb-card pos">
          <div class="fb-title positivo">✅ Ponto positivo</div>
          <div>${fb.positivo}</div>
        </div>
        <div class="fb-card neg">
          <div class="fb-title negativo">⚠️ Ponto a melhorar</div>
          <div>${fb.negativo}</div>
        </div>
      </div>
      ${fb.comentarios ? `<p style="margin-top:10px;font-size:13px"><strong>💬 Comentários:</strong> ${fb.comentarios}</p>` : ''}
      ` : ''}

      ${transcricao ? `
      <h2>Transcrição da Reunião</h2>
      <div class="transcricao">${transcricao.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      ` : ''}

      <div class="rodape">Gerado pelo Painel P3 Destilados &nbsp;·&nbsp; ${new Date().toLocaleString('pt-BR')}</div>
    </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
  }

  if (vendedorSelecionado) {
    return (
      <VendedorDashboard
        vendedorNome={vendedorSelecionado}
        mesInicial={mes}
        anoInicial={ano}
        onVoltar={() => { setVendedorSelecionado(null); setAbaInicialVendedor('hoje'); }}
        abaInicial={abaInicialVendedor}
      />
    );
  }

  const totalGeral = resumo.reduce((s, r) => s + r.comissao, 0);
  const fatGeral   = resumo.reduce((s, r) => s + r.faturamento, 0);

  // Projeção de fechamento do mês (soma das projeções individuais = fat_total / du_passados * du_total)
  // Só aplica ao mês atual; para meses passados o gráfico mostra o valor real
  const ehMesAtual = mes === hoje.getMonth() + 1 && ano === hoje.getFullYear();
  const duPass     = diasUteisPassados(ano, mes);
  const duTotal    = diasUteisNoMes(ano, mes);
  const projecaoEquipe = ehMesAtual && duPass > 0 ? Math.round((fatGeral / duPass) * duTotal) : null;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div>
            <h1 style={styles.headerTitle}>👑 Painel Admin</h1>
            <p style={styles.headerSub}>Visão consolidada de todos os vendedores</p>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => { setAbaMetas(false); setAbaUsuarios(false); setAbaReuniao(false); }} style={{ ...styles.btnSair, background: !abaMetas && !abaUsuarios && !abaReuniao ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}>Painel Geral</button>
            <button onClick={() => { setAbaMetas(true);  setAbaUsuarios(false); setAbaReuniao(false); }} style={{ ...styles.btnSair, background: abaMetas ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}>🎯 Metas</button>
            <button onClick={() => { setAbaReuniao(true); setAbaMetas(false); setAbaUsuarios(false); }} style={{ ...styles.btnSair, background: abaReuniao ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}>📋 Reunião</button>
            <button onClick={() => { setAbaUsuarios(true); setAbaMetas(false); setAbaReuniao(false); }} style={{ ...styles.btnSair, background: abaUsuarios ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}>👥 Usuários</button>
            <button onClick={logout} style={styles.btnSair}>Sair</button>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {/* Aba Usuários */}
        {abaUsuarios && (
          <GestaoUsuarios usuarioLogadoUID={usuario?.uid} />
        )}

        {/* Filtros + conteúdo principal — ocultos na aba Usuários e Reunião */}
        {!abaUsuarios && !abaReuniao && <>
        <div style={styles.filtros}>
          <select value={mes} onChange={(e) => setMes(Number(e.target.value))} style={styles.select}>
            {MESES.map((m, i) => (
              <option key={i + 1} value={i + 1}>{m}</option>
            ))}
          </select>
          <select value={ano} onChange={(e) => setAno(Number(e.target.value))} style={styles.select}>
            {anos.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {/* Totais gerais */}
        <div style={styles.cards}>
          <div style={{ ...styles.card, borderLeft: '4px solid #0f3460' }}>
            <p style={styles.cardLabel}>Faturamento total</p>
            <p style={styles.cardValor}>{moeda(fatGeral)}</p>
          </div>
          <div style={{ ...styles.card, borderLeft: '4px solid #16a34a' }}>
            <p style={styles.cardLabel}>Comissões totais</p>
            <p style={{ ...styles.cardValor, color: '#16a34a' }}>{moeda(totalGeral)}</p>
          </div>
          <div style={{ ...styles.card, borderLeft: '4px solid #7c3aed' }}>
            <p style={styles.cardLabel}>Vendedores ativos</p>
            <p style={{ ...styles.cardValor, color: '#7c3aed' }}>{resumo.length}</p>
          </div>
        </div>

        {/* Gráfico de faturamento mensal — todos os vendedores */}
        {!abaMetas && (
          <GraficoVendasMensais
            vendedor={null}
            titulo="Faturamento total da equipe · últimos 12 meses"
            projecaoMesAtual={projecaoEquipe}
          />
        )}

        {/* Aba Metas */}
        {abaMetas && (
          <div>
            {resumo.map((r) => (
              <MetaCard
                key={r.vendedor}
                vendedor={r.vendedor}
                mes={mes}
                ano={ano}
                fatAtual={r.faturamento}
              />
            ))}
            {resumo.length === 0 && !carregando && (
              <div style={styles.vazio}>Selecione um período com dados para ver as metas.</div>
            )}
          </div>
        )}

        {/* Tabela de vendedores */}
        {!abaMetas && (
          carregando ? (
            <div style={styles.centralizando}>
              <div style={styles.spinner} />
              <p style={{ color: '#6b7280' }}>Carregando dados...</p>
            </div>
          ) : erroQuery ? (
            <div style={{ padding: '16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', color: '#dc2626', fontSize: '13px' }}>
              <strong>Erro ao buscar dados:</strong> {erroQuery}
            </div>
          ) : resumo.length === 0 ? (
            <div style={styles.vazio}>
              <p>Nenhum dado encontrado para {MESES[mes - 1]} de {ano}.</p>
            </div>
          ) : (
            <div style={styles.tabela}>
              <div style={styles.tabelaHeader}>
                <span style={{ flex: 2 }}>Vendedor</span>
                <span style={{ flex: 1, textAlign: 'right' }}>Vendas</span>
                <span style={{ flex: 2, textAlign: 'right' }}>Faturamento</span>
                <span style={{ flex: 2, textAlign: 'right' }}>Comissão</span>
                <span style={{ flex: 1 }}></span>
              </div>
              {resumo.map((r, idx) => (
                <div key={r.vendedor} style={{ ...styles.tabelaRow, background: idx % 2 === 0 ? '#fff' : '#f9fafb', opacity: r.faturamento === 0 ? 0.6 : 1 }}>
                  <div style={{ flex: 2 }}>
                    <span style={styles.nomeVendedor}>{r.vendedor}</span>
                    {r.estado && <span style={styles.estadoBadge}>{r.estado}</span>}
                    {r.faturamento === 0 && <span style={{ fontSize: '10px', color: '#9ca3af', marginLeft: '6px' }}>sem vendas</span>}
                  </div>
                  <span style={{ flex: 1, textAlign: 'right', color: '#6b7280', fontSize: '14px' }}>{r.vendas || '—'}</span>
                  <span style={{ flex: 2, textAlign: 'right', fontSize: '14px', fontWeight: '500', color: r.faturamento === 0 ? '#9ca3af' : undefined }}>{r.faturamento === 0 ? '—' : moeda(r.faturamento)}</span>
                  <span style={{ flex: 2, textAlign: 'right', fontSize: '15px', fontWeight: '700', color: r.comissao === 0 ? '#9ca3af' : '#16a34a' }}>{r.comissao === 0 ? '—' : moeda(r.comissao)}</span>
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={() => setVendedorSelecionado(r.vendedor)} style={styles.btnDetalhe}>
                      Ver extrato
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
        </>}

        {/* ── ABA REUNIÃO ──────────────────────────────────────── */}
        {abaReuniao && (
          <div>
            {/* Seletor de período + vendedor */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mês / Ano</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <select value={mes} onChange={e => setMes(Number(e.target.value))} style={styles.select}>
                    {MESES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
                  </select>
                  <select value={ano} onChange={e => setAno(Number(e.target.value))} style={styles.select}>
                    {anos.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Vendedor</p>
                <select value={vendedorReuniao} onChange={e => setVendedorReuniao(e.target.value)} style={{ ...styles.select, minWidth: '220px' }}>
                  <option value="">Selecione um vendedor...</option>
                  {resumo.map(r => <option key={r.vendedor} value={r.vendedor}>{r.vendedor}</option>)}
                </select>
              </div>
            </div>

            {!vendedorReuniao ? (
              <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: '13px', padding: '60px 0', background: '#fff', borderRadius: '12px' }}>
                Selecione um vendedor para iniciar a reunião.
              </div>
            ) : (<>
              {/* 1. Régua de meta */}
              <div style={{ marginBottom: '16px' }}>
                <MetaCard vendedor={vendedorReuniao} mes={mes} ano={ano} fatAtual={resumo.find(r => r.vendedor === vendedorReuniao)?.faturamento || 0} />
              </div>

              {/* 2. Gráfico de prospecção */}
              <div style={{ background: '#fff', borderRadius: '12px', padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginBottom: '16px' }}>
                <p style={{ margin: '0 0 16px', fontSize: '13px', fontWeight: '800', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>2 · Prospecção</p>
                {carregandoGrafico ? (
                  <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: '13px', padding: '32px 0' }}>⏳ Carregando...</p>
                ) : dadosGrafico?.length === 0 ? (
                  <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: '13px', padding: '24px 0' }}>Nenhum prospecto registrado.</p>
                ) : dadosGrafico ? (
                  <GraficoProspeccao dados={dadosGrafico} />
                ) : null}
              </div>

              {/* 3-5. Metas por área */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '10px' }}>
                <ItemReuniao
                  numero="3" label="Insights Individual"
                  onAbrir={() => { setAbaInicialVendedor('produtos'); setVendedorSelecionado(vendedorReuniao); }}
                  comp={compInsights} setComp={setCompInsights}
                  salvando={salvandoComp['insights']}
                  onRegistrar={() => registrarCompromisso('insights', { texto: compInsights.texto, valor: compInsights.valor }, () => setCompInsights({ texto: '', valor: '' }))}
                  metaAnterior={metasAnteriores['insights']} avaliacao={avaliacoes['insights']}
                  onAvaliar={v => setAvaliacoes(p => ({ ...p, insights: v }))}
                />
                <ItemReuniao
                  numero="4" label="Diário"
                  onAbrir={() => { setAbaInicialVendedor('hoje'); setVendedorSelecionado(vendedorReuniao); }}
                  comp={compDiario} setComp={setCompDiario}
                  salvando={salvandoComp['diario']}
                  onRegistrar={() => registrarCompromisso('diario', { texto: compDiario.texto, valor: compDiario.valor }, () => setCompDiario({ texto: '', valor: '' }))}
                  metaAnterior={metasAnteriores['diario']} avaliacao={avaliacoes['diario']}
                  onAvaliar={v => setAvaliacoes(p => ({ ...p, diario: v }))}
                />
                <ItemReuniao
                  numero="5" label="Clientes"
                  onAbrir={() => { setAbaInicialVendedor('clientes'); setVendedorSelecionado(vendedorReuniao); }}
                  comp={compClientes} setComp={setCompClientes}
                  salvando={salvandoComp['clientes']}
                  onRegistrar={() => registrarCompromisso('clientes', { texto: compClientes.texto, valor: compClientes.valor, atrasos: compClientes.atrasos }, () => setCompClientes({ texto: '', valor: '', atrasos: '' }))}
                  extraField={
                    <input placeholder="Valor em atrasos hoje (R$)" value={compClientes.atrasos}
                      onChange={e => setCompClientes(p => ({ ...p, atrasos: e.target.value }))} style={stR.input} />
                  }
                  metaAnterior={metasAnteriores['clientes']} avaliacao={avaliacoes['clientes']}
                  onAvaliar={v => setAvaliacoes(p => ({ ...p, clientes: v }))}
                />
              </div>

              {/* 6. Feedback */}
              <div style={{ ...stR.bloco, marginBottom: '10px' }}>
                <div style={stR.header}>
                  <span style={stR.numero}>6</span>
                  <span style={stR.headerLabel}>Feedback do Gestor</span>
                  <button onClick={() => setShowFeedback(true)} style={stR.btnLink}>
                    {feedbackSalvo ? '✅ Editar feedback' : 'Registrar feedback'}
                  </button>
                </div>
                {feedbackSalvo && (
                  <div style={{ padding: '12px 16px', fontSize: '13px', color: '#374151' }}>
                    <p style={{ margin: '0 0 4px' }}><strong style={{ color: '#15803d' }}>✅</strong> {feedbackSalvo.positivo}</p>
                    <p style={{ margin: 0 }}><strong style={{ color: '#b91c1c' }}>⚠️</strong> {feedbackSalvo.negativo}</p>
                  </div>
                )}
              </div>

              {/* 7. Gerar PDF */}
              <div style={{ ...stR.bloco, marginBottom: '10px' }}>
                <div style={stR.header}>
                  <span style={stR.numero}>7</span>
                  <span style={stR.headerLabel}>Registrar Reunião (PDF)</span>
                  <button onClick={() => setShowTranscricao(true)} style={{ ...stR.btnLink, background: '#0f3460', color: '#fff', border: 'none' }}>
                    📄 Gerar PDF da Reunião
                  </button>
                </div>
              </div>
            </>)}

            {/* Modal de Feedback */}
            {showFeedback && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
                <div style={{ background: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '480px', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: '17px', fontWeight: '800' }}>Registrar Feedback</h3>
                  <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#6b7280' }}>{vendedorReuniao}</p>
                  <label style={stR.label}>✅ Ponto mais positivo sobre {normalizarVendedor(vendedorReuniao)}</label>
                  <textarea value={feedback.positivo} onChange={e => setFeedback(p => ({ ...p, positivo: e.target.value }))} rows={2} style={stR.textarea} placeholder="Ex: excelente proatividade com prospecção..." />
                  <label style={stR.label}>⚠️ Ponto a melhorar em {normalizarVendedor(vendedorReuniao)}</label>
                  <textarea value={feedback.negativo} onChange={e => setFeedback(p => ({ ...p, negativo: e.target.value }))} rows={2} style={stR.textarea} placeholder="Ex: precisa melhorar o follow-up..." />
                  <label style={stR.label}>💬 Comentários adicionais</label>
                  <textarea value={feedback.comentarios} onChange={e => setFeedback(p => ({ ...p, comentarios: e.target.value }))} rows={2} style={stR.textarea} placeholder="Opcional..." />
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                    <button onClick={() => setShowFeedback(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: '8px', background: '#fff', cursor: 'pointer', fontSize: '13px' }}>Cancelar</button>
                    <button onClick={salvarFeedback} disabled={salvandoFeedback || !feedback.positivo || !feedback.negativo} style={{ padding: '9px 18px', background: '#0f3460', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '700', opacity: salvandoFeedback ? 0.6 : 1 }}>
                      {salvandoFeedback ? 'Salvando...' : 'Salvar Feedback'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Modal de Transcrição → Gerar PDF */}
            {showTranscricao && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
                <div style={{ background: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '640px', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: '17px', fontWeight: '800' }}>📄 Gerar PDF da Reunião</h3>
                  <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#6b7280' }}>{vendedorReuniao} · {new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                  <label style={stR.label}>📝 Transcrição da reunião (opcional)</label>
                  <p style={{ margin: '0 0 6px', fontSize: '12px', color: '#9ca3af' }}>Cole aqui o texto transcrito. Ele será incluído no PDF junto com as metas e feedback.</p>
                  <textarea
                    value={transcricao}
                    onChange={e => setTranscricao(e.target.value)}
                    rows={10}
                    style={{ ...stR.textarea, minHeight: '180px' }}
                    placeholder="Cole a transcrição da reunião aqui..."
                  />
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                    <button onClick={() => setShowTranscricao(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: '8px', background: '#fff', cursor: 'pointer', fontSize: '13px' }}>Cancelar</button>
                    <button onClick={() => { setShowTranscricao(false); gerarPDF(); }} style={{ padding: '9px 18px', background: '#0f3460', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '700' }}>
                      📄 Gerar PDF
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

const stR = {
  bloco:    { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  header:   { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' },
  numero:   { fontSize: '12px', fontWeight: '800', color: '#fff', background: '#0f3460', borderRadius: '50%', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  headerLabel: { fontWeight: '700', fontSize: '14px', color: '#111827', flex: 1 },
  btnLink:  { fontSize: '12px', fontWeight: '700', padding: '5px 12px', background: '#fff', border: '1.5px solid #0f3460', color: '#0f3460', borderRadius: '7px', cursor: 'pointer', flexShrink: 0 },
  body:     { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  cardAnterior: { background: '#fffbeb', border: '1.5px solid #fbbf24', borderRadius: '9px', padding: '12px 14px' },
  cardNenhuma:  { background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: '9px', padding: '10px 14px', fontSize: '13px', color: '#9ca3af', textAlign: 'center' },
  cardMeta: { background: '#eff6ff', border: '1.5px solid #3b82f6', borderRadius: '9px', padding: '12px 14px' },
  metaTexto: { margin: '0 0 8px', fontSize: '13px', color: '#374151', fontWeight: '600' },
  metaValor: { margin: '0 0 10px', fontSize: '12px', color: '#6b7280' },
  avalRow:  { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  avalLabel: { fontSize: '12px', fontWeight: '700', color: '#78350f', marginRight: '4px' },
  btnAval:  { padding: '5px 12px', borderRadius: '7px', border: '1.5px solid', cursor: 'pointer', fontSize: '12px', fontWeight: '700', transition: 'all 0.15s' },
  sectionTitle: { fontSize: '11px', fontWeight: '800', color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' },
  inputRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  input:    { flex: 1, minWidth: '120px', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: '7px', fontSize: '13px', fontFamily: 'inherit', outline: 'none' },
  btnAcordar: { padding: '7px 16px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '700', flexShrink: 0 },
  label:    { display: 'block', fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px', marginTop: '12px' },
  textarea: { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical', outline: 'none', boxSizing: 'border-box' },
};

function ItemReuniao({ numero, label, onAbrir, comp, setComp, salvando, onRegistrar, extraField, metaAnterior, avaliacao, onAvaliar }) {
  const dataFmt = metaAnterior?.dataReuniao
    ? new Date(metaAnterior.dataReuniao + 'T12:00:00').toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })
    : null;

  return (
    <div style={stR.bloco}>
      {/* Cabeçalho com número + label + botão de navegação */}
      <div style={stR.header}>
        <span style={stR.numero}>{numero}</span>
        <span style={stR.headerLabel}>{label}</span>
        <button onClick={onAbrir} style={stR.btnLink}>Abrir {label} →</button>
      </div>

      <div style={stR.body}>
        {/* Bloco 1: Meta anterior */}
        {metaAnterior ? (
          <div style={stR.cardAnterior}>
            <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: '800', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              📌 Meta acordada em {dataFmt}
            </p>
            <p style={stR.metaTexto}>{metaAnterior.texto}</p>
            {metaAnterior.valor && (
              <p style={stR.metaValor}>Valor: R$ {Number(metaAnterior.valor).toLocaleString('pt-BR')}</p>
            )}
            {metaAnterior.atingida === true ? (
              <p style={{ margin: 0, fontSize: '13px', color: '#15803d', fontWeight: '700' }}>✅ Meta atingida</p>
            ) : metaAnterior.atingida === false ? (
              <p style={{ margin: 0, fontSize: '13px', color: '#b91c1c', fontWeight: '700' }}>❌ Meta não atingida</p>
            ) : (
              <div style={stR.avalRow}>
                <span style={stR.avalLabel}>Essa meta foi atingida?</span>
                <button
                  onClick={() => onAvaliar(true)}
                  style={{ ...stR.btnAval, borderColor: avaliacao === true ? '#16a34a' : '#d1d5db', background: avaliacao === true ? '#dcfce7' : '#fff', color: avaliacao === true ? '#15803d' : '#374151' }}
                >
                  ✅ Sim
                </button>
                <button
                  onClick={() => onAvaliar(false)}
                  style={{ ...stR.btnAval, borderColor: avaliacao === false ? '#dc2626' : '#d1d5db', background: avaliacao === false ? '#fee2e2' : '#fff', color: avaliacao === false ? '#b91c1c' : '#374151' }}
                >
                  ❌ Não
                </button>
                {avaliacao === null && (
                  <span style={{ fontSize: '11px', color: '#9ca3af' }}>Avalie antes de acordar a nova meta</span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={stR.cardNenhuma}>Nenhuma meta registrada na reunião anterior</div>
        )}

        {/* Bloco 2: Acordar nova meta */}
        <div style={stR.cardMeta}>
          <p style={stR.sectionTitle}>🎯 Acordar meta para essa semana</p>
          <div style={stR.inputRow}>
            {extraField}
            <input
              placeholder="Descreva a meta acordada com o vendedor"
              value={comp.texto}
              onChange={e => setComp(p => ({ ...p, texto: e.target.value }))}
              style={stR.input}
            />
            <input
              placeholder="Valor (R$)"
              type="number"
              value={comp.valor}
              onChange={e => setComp(p => ({ ...p, valor: e.target.value }))}
              style={{ ...stR.input, maxWidth: '120px' }}
            />
            <button
              onClick={onRegistrar}
              disabled={salvando || !comp.texto || (metaAnterior && metaAnterior.atingida === null && avaliacao === null)}
              style={{ ...stR.btnAcordar, opacity: (salvando || !comp.texto || (metaAnterior && metaAnterior.atingida === null && avaliacao === null)) ? 0.45 : 1 }}
            >
              {salvando ? 'Salvando...' : '✓ Acordar meta'}
            </button>
          </div>
          {metaAnterior && metaAnterior.atingida === null && avaliacao === null && (
            <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#6b7280' }}>
              Avalie a meta anterior para liberar o registro da nova.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f3f4f6', fontFamily: 'Inter, sans-serif' },
  header: { background: '#0f3460', color: '#fff', padding: '0 20px' },
  headerInner: { maxWidth: '1000px', margin: '0 auto', padding: '16px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { margin: 0, fontSize: '20px', fontWeight: '700' },
  headerSub: { margin: 0, fontSize: '13px', opacity: 0.8, marginTop: '2px' },
  btnSair: { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', padding: '7px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontFamily: 'inherit' },
  main: { maxWidth: '1000px', margin: '0 auto', padding: '24px 16px' },
  filtros: { display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' },
  select: { padding: '9px 14px', border: '1.5px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', outline: 'none' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' },
  card: { background: '#fff', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  cardLabel: { margin: '0 0 6px', fontSize: '12px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' },
  cardValor: { margin: 0, fontSize: '26px', fontWeight: '700', color: '#111827' },
  tabela: { background: '#fff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  tabelaHeader: { display: 'flex', alignItems: 'center', padding: '12px 16px', background: '#f8fafc', borderBottom: '2px solid #e5e7eb', fontSize: '12px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tabelaRow: { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #f0f0f0', gap: '8px' },
  nomeVendedor: { fontWeight: '600', fontSize: '14px', color: '#111827', marginRight: '8px' },
  estadoBadge: { fontSize: '11px', padding: '2px 7px', borderRadius: '20px', background: '#ede9fe', color: '#7c3aed', fontWeight: '600' },
  btnDetalhe: { fontSize: '12px', padding: '5px 12px', background: '#0f3460', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: '500' },
  centralizando: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 0', gap: '12px' },
  spinner: { width: '32px', height: '32px', border: '3px solid #e5e7eb', borderTop: '3px solid #0f3460', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  vazio: { textAlign: 'center', padding: '60px 0', color: '#6b7280', background: '#fff', borderRadius: '12px' },
};

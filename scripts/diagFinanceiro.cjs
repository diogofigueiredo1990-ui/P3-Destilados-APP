const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const sa = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

async function main() {
  // 1. Verifica documentos GO_ no financeiro
  console.log('\n=== 1. Verificando GO_133, GO_164, GO_197 ===');
  for (const id of ['GO_133', 'GO_164', 'GO_197']) {
    const doc = await db.collection('financeiro').doc(id).get();
    if (!doc.exists) {
      console.log(`${id}: NÃO EXISTE`);
    } else {
      const d = doc.data();
      console.log(`${id}: existe | docId=${d.docId} | statusGeral=${d.statusGeral} | comissaoBloqueada=${d.comissaoBloqueada} | cliente=${d.cliente}`);
      const atrasados = (d.boletos||[]).filter(b => b.status === 'ATRASADO');
      console.log(`  → ATRASADOS: ${atrasados.length}`, JSON.stringify(atrasados.map(b => ({venc: b.dataVencimento, val: b.valorEmAberto, dias: b.diasAtraso, comBloq: b.comissaoBloqueada}))));
    }
  }

  // 2. Query por docId field
  console.log('\n=== 2. Query financeiro where docId in [GO_133, GO_164, GO_197] ===');
  const snap = await db.collection('financeiro').where('docId', 'in', ['GO_133', 'GO_164', 'GO_197']).get();
  console.log(`Encontrados via query: ${snap.size}`);

  // 3. Busca clientes por nome
  console.log('\n=== 3. Clientes com MCO, RVS, VAN, NILIA ===');
  const cliSnap = await db.collection('clientes').get();
  const targets = [];
  cliSnap.docs.forEach(d => {
    const nome = (d.data().nome || '').toUpperCase();
    if (nome.includes('MCO') || nome.includes('RVS') || nome.includes('VAN SANTANA') || nome.includes('NILIA')) {
      targets.push({ cnpj: d.id, nome: d.data().nome, bloqueio: d.data().statusBloqueio });
      console.log(' Cliente:', d.data().nome, '| CNPJ:', d.id, '| Bloqueio:', d.data().statusBloqueio);
    }
  });

  // 4. Para cada CNPJ dos targets, busca pedidos
  console.log('\n=== 4. Pedidos por CNPJ ===');
  for (const cli of targets) {
    const cnpjNum = cli.cnpj.replace(/\D/g, '');
    // tenta os dois formatos
    for (const cnpjQ of [cli.cnpj, cnpjNum]) {
      const pSnap = await db.collection('pedidos').where('cnpj', '==', cnpjQ).limit(10).get();
      if (!pSnap.empty) {
        const vendedores = [...new Set(pSnap.docs.map(d => d.data().vendedorResponsavel))];
        const chaves = [...new Set(pSnap.docs.map(d => d.data().chave))].slice(0, 5);
        console.log(`${cli.nome} [${cnpjQ}]: ${pSnap.size} pedidos | vendedores: ${vendedores.join(', ')}`);
        console.log('  chaves:', chaves);
        break;
      }
    }
  }

  // 5. Amostra de vendedores únicos
  console.log('\n=== 5. Vendedores únicos (amostra 500 pedidos) ===');
  const allPed = await db.collection('pedidos').limit(500).get();
  const vends = new Set(allPed.docs.map(d => d.data().vendedorResponsavel));
  console.log([...vends].filter(v => v).sort().join('\n'));
}

main().catch(console.error).finally(() => process.exit());

// Diagnóstico: verifica GO_133, GO_164, GO_197 + busca por CNPJ dos clientes sem dados
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
      console.log(`${id}: existe | docId=${d.docId} | statusGeral=${d.statusGeral} | comissaoBloqueada=${d.comissaoBloqueada} | boletos=${(d.boletos||[]).length}`);
      const atrasados = (d.boletos||[]).filter(b => b.status === 'ATRASADO');
      console.log(`  → ATRASADOS: ${atrasados.length}`, atrasados.map(b => `venc=${b.dataVencimento} val=${b.valorEmAberto} dias=${b.diasAtraso} comBloq=${b.comissaoBloqueada}`));
    }
  }

  // 2. Busca por docId (campo) nos docs GO_
  console.log('\n=== 2. Query financeiro where docId in [GO_133, GO_164, GO_197] ===');
  const snap = await db.collection('financeiro').where('docId', 'in', ['GO_133', 'GO_164', 'GO_197']).get();
  console.log(`Encontrados: ${snap.size}`);
  snap.docs.forEach(d => console.log(' -', d.id, '| docId:', d.data().docId));

  // 3. Busca clientes bloqueados para Ana Carolina (CNPJs)
  console.log('\n=== 3. CNPJs dos clientes bloqueados - pedidos com "MCO", "RVS", "VAN SANTANA" ===');
  
  // Busca clientes por nome parcial nos clientes
  const cliSnap = await db.collection('clientes').get();
  const targets = [];
  cliSnap.docs.forEach(d => {
    const nome = (d.data().nome || '').toUpperCase();
    if (nome.includes('MCO') || nome.includes('RVS') || nome.includes('VAN SANTANA') || nome.includes('NILIA')) {
      targets.push({ cnpj: d.id, nome: d.data().nome, bloqueio: d.data().statusBloqueio, tel: d.data().telefone });
    }
  });
  console.log('Clientes encontrados:', targets);

  // 4. Para cada CNPJ, busca pedidos (qualquer vendedor)
  for (const cli of targets) {
    const pSnap = await db.collection('pedidos').where('cnpj', '==', cli.cnpj).limit(5).get();
    if (pSnap.empty) {
      // tenta normalizado
      const cnpjNum = cli.cnpj.replace(/\D/g, '');
      const pSnap2 = await db.collection('pedidos').where('cnpj', '==', cnpjNum).limit(5).get();
      if (pSnap2.empty) {
        console.log(`${cli.nome} (${cli.cnpj}): SEM PEDIDOS`);
      } else {
        console.log(`${cli.nome} (cnpj num): ${pSnap2.size} pedidos | vendedores: ${[...new Set(pSnap2.docs.map(d => d.data().vendedorResponsavel))].join(', ')}`);
        const chaves = pSnap2.docs.map(d => d.data().chave);
        console.log('  chaves:', chaves.slice(0,5));
      }
    } else {
      const vendedores = [...new Set(pSnap.docs.map(d => d.data().vendedorResponsavel))];
      console.log(`${cli.nome} (${cli.cnpj}): ${pSnap.size} pedidos | vendedores: ${vendedores.join(', ')}`);
      const chaves = pSnap.docs.map(d => d.data().chave);
      console.log('  chaves:', chaves.slice(0,5));
    }
  }

  // 5. Verifica se Ana Carolina tem outros nomes de clientes nos pedidos
  console.log('\n=== 5. Todos vendedorResponsavel únicos em pedidos (amostra) ===');
  const allPedSnap = await db.collection('pedidos').limit(200).get();
  const vendedores = new Set(allPedSnap.docs.map(d => d.data().vendedorResponsavel));
  console.log([...vendedores].sort().join('\n'));
}

main().catch(console.error).finally(() => process.exit());

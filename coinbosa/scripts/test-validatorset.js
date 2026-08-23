// Banc du contrat système 0x…1000, contre une chaîne réelle.
//
// Ce que la CI ne couvrait PAS jusqu'ici : getMiningValidators, l'idempotence
// d'init(), le refus d'une rotation sans le validateur de genèse, le refus d'un
// appel hors gouverneur, et le fait que deposit / distributeFinalityReward ne
// revertent pas. Un revert sur ces chemins arrête la chaîne.
const { ethers } = require('ethers');

const RPC = process.env.RPC || 'http://127.0.0.1:8545';
const VALSET = '0x0000000000000000000000000000000000001000';
const ZERO_VOTE = '0x' + '00'.repeat(48);

const ABI = [
  'function init()',
  'function getMiningValidators() view returns (address[] vals, bytes[] votes)',
  'function getValidators() view returns (address[])',
  'function getTurnLength() view returns (uint256)',
  'function numOfValidators() view returns (uint256)',
  'function isCurrentValidator(address who) view returns (bool)',
  'function deposit(address valAddr) payable',
  'function distributeFinalityReward(address[] validatorsIn, uint256[] weights)',
  'function updateValidatorSet(address[] newVals, bytes[] newVotes)',
  'function claim()',
  'function GOVERNOR() view returns (address)',
  'function INITIAL_VALIDATOR() view returns (address)',
  'function alreadyInit() view returns (bool)',
];

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mECHEC\x1b[0m'} ${name}${ok ? '' : `\n         attendu : ${expected}\n         obtenu  : ${actual}`}`);
}

async function expectRevert(name, promise) {
  try {
    const tx = await promise;
    if (tx && typeof tx.wait === 'function') await tx.wait();
    fail++;
    console.log(`  \x1b[31mECHEC\x1b[0m ${name} — aurait dû échouer`);
  } catch (_e) {
    pass++;
    console.log(`  \x1b[32mOK  \x1b[0m ${name} (rejetée comme prévu)`);
  }
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(VALSET, ABI, provider);
  console.log('\nCoinbosaValidatorSet — banc du chemin consensus\n');

  const governor = await c.GOVERNOR();
  const initial = await c.INITIAL_VALIDATOR();
  const n = await c.numOfValidators();
  const [vals, votes] = await c.getMiningValidators();
  const listed = await c.getValidators();

  console.log(`  gouverneur           : ${governor}`);
  console.log(`  validateur de genèse : ${initial}`);
  console.log(`  numOfValidators()    : ${n}`);
  console.log(`  getMiningValidators  : ${vals.length} adresse(s)\n`);

  check('alreadyInit() est vrai après le bloc 1', await c.alreadyInit(), true);
  check('numOfValidators() ≥ 1', n >= 1n, true);
  check('getMiningValidators() non vide', vals.length > 0, true);
  check('getMiningValidators contient le validateur de genèse', vals.some((a) => a.toLowerCase() === initial.toLowerCase()), true);
  check('getValidators() a la même longueur', listed.length, vals.length);
  check('getTurnLength() vaut 1 (Bohr inactif)', await c.getTurnLength(), 1n);
  check('isCurrentValidator(INITIAL_VALIDATOR)', await c.isCurrentValidator(initial), true);
  check('chaque clé de vote fait 48 octets', votes.every((v) => ethers.getBytes(v).length === 48), true);

  // init() est sur le chemin de consensus : un revert arrête le bloc 1. Après
  // alreadyInit, l'appel doit être un no-op, pas un revert.
  const initData = c.interface.encodeFunctionData('init');
  await provider.call({ to: VALSET, data: initData });
  pass++;
  console.log('  \x1b[32mOK  \x1b[0m init() idempotent (eth_call ne revert pas)');
  check('alreadyInit() reste vrai après init() superflu', await c.alreadyInit(), true);

  // deposit et distributeFinalityReward : jamais de revert, même avec des arguments vides
  // ou une adresse quelconque. Ce sont des system-tx.
  await provider.call({ to: VALSET, data: c.interface.encodeFunctionData('deposit', [ethers.ZeroAddress]) });
  pass++;
  console.log('  \x1b[32mOK  \x1b[0m deposit(0x0) ne revert pas');
  await provider.call({
    to: VALSET,
    data: c.interface.encodeFunctionData('distributeFinalityReward', [[], []]),
  });
  pass++;
  console.log('  \x1b[32mOK  \x1b[0m distributeFinalityReward([], []) ne revert pas');

  // Administration : un tiers ne peut pas tourner le set. eth_call depuis une
  // adresse random — on n'envoie RIEN on-chain.
  const etranger = ethers.Wallet.createRandom().address;
  const votePlaceholder = '0x' + ethers.keccak256(initial).slice(2).padEnd(96, '0').slice(0, 96);
  await expectRevert(
    'updateValidatorSet par un non-gouverneur rejeté',
    provider.call({
      from: etranger,
      to: VALSET,
      data: c.interface.encodeFunctionData('updateValidatorSet', [[initial], [votePlaceholder]]),
    })
  );

  // Rotation qui retire le validateur de genèse : le contrat doit revert.
  const autre = '0x0000000000000000000000000000000000009999';
  const voteAutre = '0x' + ethers.keccak256(autre).slice(2).padEnd(96, '0').slice(0, 96);
  await expectRevert(
    'updateValidatorSet sans le validateur de genèse rejeté',
    provider.call({
      from: governor,
      to: VALSET,
      data: c.interface.encodeFunctionData('updateValidatorSet', [[autre], [voteAutre]]),
    })
  );

  // Ensemble vide
  await expectRevert(
    'updateValidatorSet([]) rejeté',
    provider.call({
      from: governor,
      to: VALSET,
      data: c.interface.encodeFunctionData('updateValidatorSet', [[], []]),
    })
  );

  // claim sans dépôt
  await expectRevert(
    'claim() sans solde rejeté',
    provider.call({
      from: etranger,
      to: VALSET,
      data: c.interface.encodeFunctionData('claim'),
    })
  );

  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${pass} tests réussis, ${fail} échec(s)`);
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nERREUR FATALE :', e.message); process.exit(1); });

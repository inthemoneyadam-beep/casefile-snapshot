/**
 * How the Labs page read a lab value before 2026-10 (commit d43790a), FROZEN: used only to count what the one-time
 * re-read changes (services/lab-backfill.ts) and in its tests. Never used to show, judge, group or compare a value.
 *
 * Everything between the "frozen" markers below is copied verbatim from `git show d43790a:src/server/services/labs.ts`
 * (never from the working tree), with only the `export` keywords removed: the synonym table and analyte normaliser,
 * the specimen helpers, and the old value, range and flag helpers. `legacyRowView` and `legacyFactView` rebuild the
 * old entry's view exactly as labs.ts at d43790a built it (readWholeLabEntries' row mapping, factEntry). Do not edit
 * the frozen part; a later change to how values are read is counted against this same baseline.
 */
import { normalizeKey, parseJson } from '../util/ids';

/** The commit this baseline was copied from. */
export const LEGACY_LABS_COMMIT = 'd43790a9f8c41c1cb467665cb7f1cced6d66fa8b';

// ---- frozen from d43790a src/server/services/labs.ts, ANALYTE_SYNONYMS (labs.ts:36-210) ----

/** canonical key -> every spelling that means the same test (all normalised with normalizeKey). */
const ANALYTE_SYNONYMS: Record<string, string[]> = {
  wbc: ['wbc', 'white blood cell count', 'white blood cells', 'white cell count', 'white cells', 'leukocytes', 'leucocytes', 'leukocyte count', 'leucocyte count', 'white count', 'total wbc', 'wbc count'],
  rbc: ['rbc', 'red blood cells', 'red blood cell count', 'red cell count', 'erythrocytes', 'rbc count'],
  // CSF spellings. A bare word ("appearance", "color", "nucleated", "OP") is read as the CSF test only on a CSF
  // specimen or when the name says CSF (lookup tries "csf <name>" first there), so a urine "Appearance" stays urine's.
  'csf protein': ['csf protein', 'protein csf', 'csf total protein', 'total protein csf', 'csf tp', 'spinal fluid protein', 'protein spinal fluid', 'csf proteins', 'csf prot', 'csf protein total', 'protein total csf'],
  'csf glucose': ['csf glucose', 'glucose csf', 'spinal fluid glucose', 'glucose spinal fluid', 'csf glu', 'csf sugar'],
  'csf albumin': ['csf albumin', 'albumin csf', 'spinal fluid albumin'],
  'csf cell count': [
    'csf cell count', 'cell count csf', 'csf cells', 'csf nucleated cells', 'nucleated cells', 'nucleated cell count', 'nucleated cells csf', 'total nucleated cells',
    'total nucleated cell count', 'tnc', 'csf tnc', 'csf wbc', 'wbc csf', 'csf white blood cells', 'csf white blood cell count', 'csf white cell count', 'csf white cells',
    'csf leukocytes', 'leukocytes csf', 'csf wbc count', 'white blood cells csf',
    // A raw and a corrected count are the same test (the value text keeps which one it is).
    'csf nucleated', 'csf nucleated cell', 'csf nucleated cell count', 'csf total nucleated cells', 'csf wbc corrected', 'wbc csf corrected', 'csf corrected wbc', 'corrected wbc csf',
    'csf wbc raw', 'csf raw wbc', 'csf cell count raw', 'csf cell count corrected', 'csf corrected cell count', 'csf leucocytes', 'csf leukocyte count', 'csf white count', 'csf wbcs',
  ],
  'csf rbc': [
    'csf rbc', 'rbc csf', 'csf red blood cells', 'red blood cells csf', 'csf red cell count', 'csf red cells', 'csf rbc count', 'csf erythrocytes', 'erythrocytes csf', 'csf red blood cell count',
    'csf rbcs', 'csf red cell', 'csf erythrocyte count',
  ],
  'igg index': ['igg index', 'csf igg index', 'igg index csf', 'csf serum igg index', 'igg idx'],
  'igg synthesis rate': ['igg synthesis rate', 'csf igg synthesis rate', 'igg synthesis', 'intrathecal igg synthesis', 'intrathecal igg synthesis rate', 'igg synth rate', 'igg synthesis rate csf'],
  'albumin index': [
    'albumin index', 'csf serum albumin ratio', 'csf serum albumin index', 'albumin ratio', 'albumin quotient', 'qalb', 'q alb', 'csf albumin ratio', 'csf serum albumin',
    'csf albumin index', 'albumin csf serum ratio', 'albumin index csf', 'csf serum albumin quotient', 'q albumin',
  ],
  'oligoclonal bands': [
    'oligoclonal bands', 'ocb', 'ocbs', 'oligoclonal banding', 'oligoclonal band', 'csf oligoclonal bands', 'oligoclonal bands csf', 'o bands', 'oligoclonal', 'oligoclonal igg bands', 'csf ocb',
    'csf ocbs', 'ocb csf', 'csf oligoclonal igg bands', 'oligoclonal igg bands csf', 'csf oligoclonal banding', 'csf restricted oligoclonal bands', 'csf specific oligoclonal bands',
    'unique csf oligoclonal bands', 'csf oligoclonal band',
  ],
  esr: ['esr', 'sed rate', 'sedimentation rate', 'erythrocyte sedimentation rate', 'westergren', 'westergren esr', 'esr westergren', 'erythrocyte sed rate'],
  crp: ['crp', 'c reactive protein', 'creactive protein', 'hs crp', 'hscrp', 'high sensitivity crp', 'high sensitivity c reactive protein', 'c reactive protein high sensitivity', 'crp high sensitivity'],
  ana: ['ana', 'antinuclear antibody', 'antinuclear antibodies', 'anti nuclear antibody', 'anti nuclear antibodies', 'ana screen', 'ana titer', 'ana titre', 'ana ifa', 'ana pattern', 'antinuclear ab'],
  tsh: ['tsh', 'thyroid stimulating hormone', 'thyrotropin', 'thyroid stimulating hormone tsh', 'tsh 3rd generation', 'tsh third generation'],
  'vitamin b12': ['vitamin b12', 'b12', 'vit b12', 'cobalamin', 'cyanocobalamin', 'b 12', 'vitamin b 12', 'vitamin b12 cobalamin'],
  'vitamin d': [
    'vitamin d', 'vit d', '25 oh vitamin d', '25 hydroxyvitamin d', '25 hydroxy vitamin d', '25 oh d', '25ohd', 'vitamin d 25 hydroxy', 'calcidiol', 'vitamin d 25 oh', 'vitamin d3',
    '25 oh d3', 'vitamin d total', 'vitamin d 25 hydroxy total', '25 hydroxyvitamin d total', 'vit d 25 oh', 'vitamin d 25 oh total', '25 hydroxy vitamin d total',
  ],
  // --- Panel taxonomy synonyms (slice R). Abbreviations that lab systems print so "Hgb" and "Hemoglobin" are one row. ---
  // CSF
  'opening pressure': [
    'opening pressure', 'csf opening pressure', 'opening pressure csf', 'lumbar puncture opening pressure', 'lp opening pressure', 'op csf',
    // The pressure measured at a lumbar puncture, however a report names it: "ICP (opening pressure)", "OP", "LP pressure".
    'icp opening pressure', 'opening pressure icp', 'icp', 'intracranial pressure', 'intracranial pressure icp', 'icp intracranial pressure', 'op', 'csf op', 'csf pressure',
    'lp pressure', 'opening csf pressure', 'lp op', 'opening pressure op', 'op opening pressure', 'csf opening pressure op', 'icp op', 'lumbar puncture pressure',
    'lumbar opening pressure', 'spinal opening pressure', 'csf opening pressure lp', 'opening pressure lp', 'opening pressure lumbar puncture', 'pressure opening', 'opening',
  ],
  'closing pressure': ['closing pressure', 'csf closing pressure', 'closing pressure csf', 'lp closing pressure', 'lumbar puncture closing pressure', 'closing csf pressure', 'closing', 'cp csf', 'csf cp'],
  'csf appearance': [
    'csf appearance', 'appearance csf', 'csf clarity', 'clarity csf', 'csf macroscopic appearance', 'macroscopic appearance csf', 'csf gross appearance', 'gross appearance csf',
    'csf turbidity', 'turbidity csf', 'csf appearance clarity', 'csf clarity appearance', 'csf character', 'csf macroscopic', 'csf gross',
  ],
  'csf color': ['csf color', 'csf colour', 'color csf', 'colour csf', 'csf fluid color', 'csf fluid colour'],
  'csf xanthochromia': ['csf xanthochromia', 'xanthochromia csf', 'xanthochromia', 'xanthochromia screen', 'csf xanthochromia screen', 'csf supernatant xanthochromia'],
  'csf lactate': ['csf lactate', 'lactate csf', 'spinal fluid lactate', 'csf lactic acid', 'lactic acid csf', 'csf lact'],
  'csf ldh': ['csf ldh', 'ldh csf', 'csf lactate dehydrogenase', 'lactate dehydrogenase csf', 'csf ld'],
  'csf serum glucose ratio': [
    'csf serum glucose ratio', 'csf glucose ratio', 'csf blood glucose ratio', 'csf to serum glucose ratio', 'csf to blood glucose ratio', 'csf plasma glucose ratio',
    'glucose ratio csf serum', 'csf serum glucose', 'csf blood glucose', 'csf glucose serum glucose ratio',
  ],
  'csf myelin basic protein': ['csf myelin basic protein', 'myelin basic protein csf', 'myelin basic protein', 'csf mbp', 'mbp csf', 'mbp'],
  'csf cytology': ['csf cytology', 'cytology csf', 'csf cytopathology', 'cytopathology csf', 'csf cytology report', 'csf cytologic examination'],
  'csf culture': ['csf culture', 'culture csf', 'csf bacterial culture', 'bacterial culture csf', 'csf aerobic culture', 'csf culture bacterial'],
  'csf gram stain': ['csf gram stain', 'gram stain csf', 'csf gram'],
  'csf ace': ['csf ace', 'ace csf', 'csf angiotensin converting enzyme', 'angiotensin converting enzyme csf'],
  ace: ['ace', 'angiotensin converting enzyme', 'angiotensin converting enzyme ace', 'ace level', 'serum ace'],
  // Infectious work-up of meningitis (the specimen keeps a CSF PCR apart from a blood one).
  'hsv pcr': [
    'hsv pcr', 'hsv 1 2 pcr', 'hsv 1 and 2 pcr', 'hsv1 2 pcr', 'hsv 1 hsv 2 pcr', 'hsv1 hsv2 pcr', 'herpes simplex virus pcr', 'herpes simplex pcr', 'hsv dna pcr', 'hsv 1 2 dna pcr',
    'herpes simplex virus 1 2 pcr', 'herpes simplex virus 1 and 2 pcr', 'herpes simplex virus dna', 'hsv dna', 'herpes simplex virus 1 2 dna pcr', 'hsv pcr csf', 'csf hsv pcr', 'hsv 1 2 pcr csf', 'csf hsv 1 2 pcr',
  ],
  'vzv pcr': ['vzv pcr', 'varicella zoster pcr', 'varicella zoster virus pcr', 'vzv dna pcr', 'varicella zoster virus dna', 'vzv dna', 'csf vzv pcr', 'vzv pcr csf'],
  'enterovirus pcr': [
    'enterovirus pcr', 'enteroviral pcr', 'enterovirus rna pcr', 'enterovirus rt pcr', 'ev pcr', 'enterovirus rna', 'enterovirus nucleic acid', 'enterovirus by pcr',
    'enterovirus rna qualitative pcr', 'csf enterovirus pcr', 'enterovirus pcr csf', 'enterovirus rna csf', 'csf enterovirus rna',
  ],
  'cryptococcal antigen': [
    'cryptococcal antigen', 'crag', 'crypto ag', 'cryptococcus antigen', 'cryptococcal ag', 'cryptococcal antigen screen', 'cryptococcus neoformans antigen', 'crypto antigen',
    'cryptococcal antigen lfa', 'crag lfa', 'csf cryptococcal antigen', 'cryptococcal antigen csf', 'csf crag', 'crag csf',
  ],
  vdrl: ['vdrl', 'csf vdrl', 'vdrl csf', 'venereal disease research laboratory', 'vdrl test', 'syphilis vdrl', 'vdrl syphilis'],
  'meningitis encephalitis panel': [
    'meningitis encephalitis panel', 'me panel', 'biofire me panel', 'biofire meningitis encephalitis panel', 'filmarray me panel', 'filmarray meningitis encephalitis panel',
    'meningitis panel', 'meningitis encephalitis pcr panel', 'biofire', 'filmarray me', 'csf me panel', 'csf meningitis encephalitis panel', 'meningitis encephalitis panel csf',
  ],
  'csf igg': ['csf igg', 'igg csf', 'spinal fluid igg', 'csf immunoglobulin g', 'immunoglobulin g csf'],
  'csf kappa free light chains': ['csf kappa free light chains', 'csf kappa free light chain', 'kappa free light chains csf', 'csf kflc', 'kflc csf', 'csf kappa flc', 'kappa flc csf', 'csf free kappa light chains', 'csf kappa'],
  // CBC
  hemoglobin: ['hemoglobin', 'haemoglobin', 'hgb', 'hb', 'hemoglobin hgb', 'haemoglobin hb'],
  hematocrit: ['hematocrit', 'haematocrit', 'hct', 'packed cell volume', 'pcv', 'hematocrit hct'],
  platelets: ['platelets', 'platelet count', 'plt', 'plt count', 'thrombocytes', 'platelet', 'platelets plt'],
  mcv: ['mcv', 'mean corpuscular volume', 'mean cell volume'],
  mch: ['mch', 'mean corpuscular hemoglobin', 'mean corpuscular haemoglobin', 'mean cell hemoglobin'],
  mchc: ['mchc', 'mean corpuscular hemoglobin concentration', 'mean corpuscular haemoglobin concentration', 'mean cell hemoglobin concentration'],
  rdw: ['rdw', 'red cell distribution width', 'rdw cv', 'rdw sd', 'red blood cell distribution width'],
  mpv: ['mpv', 'mean platelet volume'],
  neutrophils: ['neutrophils', 'neutrophil', 'neutrophil count', 'absolute neutrophil count', 'anc', 'neutrophils absolute', 'abs neutrophils', 'absolute neutrophils', 'neutrophils abs', 'neut abs', 'segmented neutrophils', 'segs', 'polys', 'neutrophil absolute'],
  lymphocytes: ['lymphocytes', 'lymphocyte', 'lymphocyte count', 'absolute lymphocyte count', 'alc', 'lymphocytes absolute', 'abs lymphocytes', 'absolute lymphocytes', 'lymphocytes abs', 'lymphs', 'lymphs abs', 'lymph abs'],
  monocytes: ['monocytes', 'monocyte', 'monocyte count', 'absolute monocyte count', 'monocytes absolute', 'abs monocytes', 'absolute monocytes', 'monocytes abs', 'monos', 'mono abs'],
  eosinophils: ['eosinophils', 'eosinophil', 'eosinophil count', 'absolute eosinophil count', 'eosinophils absolute', 'abs eosinophils', 'absolute eosinophils', 'eosinophils abs', 'eos', 'eos abs'],
  basophils: ['basophils', 'basophil', 'basophil count', 'absolute basophil count', 'basophils absolute', 'abs basophils', 'absolute basophils', 'basophils abs', 'basos', 'baso abs'],
  // Metabolic
  sodium: ['sodium', 'na', 'sodium na', 'serum sodium'],
  potassium: ['potassium', 'k', 'potassium k', 'serum potassium'],
  chloride: ['chloride', 'cl', 'chloride cl', 'serum chloride'],
  co2: ['co2', 'bicarbonate', 'hco3', 'carbon dioxide', 'total co2', 'co2 total', 'bicarb', 'tco2', 'carbon dioxide total', 'co2 content'],
  bun: ['bun', 'blood urea nitrogen', 'urea nitrogen', 'urea', 'urea nitrogen bun', 'bun urea nitrogen'],
  creatinine: ['creatinine', 'creat', 'cr', 'serum creatinine', 'creatinine serum', 'creatinine cr'],
  egfr: ['egfr', 'gfr', 'estimated gfr', 'gfr estimated', 'estimated glomerular filtration rate', 'glomerular filtration rate', 'egfr ckd epi', 'egfr non african american', 'egfr african american', 'egfr ckd epi 2021'],
  glucose: ['glucose', 'blood glucose', 'plasma glucose', 'glucose fasting', 'fasting glucose', 'glucose random', 'random glucose', 'glu', 'fasting blood glucose', 'fbg', 'fasting plasma glucose'],
  calcium: ['calcium', 'ca', 'total calcium', 'calcium total', 'serum calcium', 'calcium ca'],
  magnesium: ['magnesium', 'mg', 'serum magnesium', 'magnesium mg'],
  phosphorus: ['phosphorus', 'phosphate', 'phos', 'inorganic phosphorus', 'phosphorus inorganic', 'po4', 'phosphorous', 'inorganic phosphate'],
  albumin: ['albumin', 'serum albumin', 'alb', 'albumin alb'],
  'total protein': ['total protein', 'protein total', 'tp', 'serum total protein', 'protein', 'serum protein', 'protein tp'],
  ast: ['ast', 'sgot', 'aspartate aminotransferase', 'aspartate transaminase', 'ast sgot', 'aspartate aminotransferase ast', 'got'],
  alt: ['alt', 'sgpt', 'alanine aminotransferase', 'alanine transaminase', 'alt sgpt', 'alanine aminotransferase alt', 'gpt'],
  'alkaline phosphatase': ['alkaline phosphatase', 'alp', 'alk phos', 'alkaline phosphatase alp', 'alk phosphatase', 'alkp'],
  bilirubin: ['bilirubin', 'total bilirubin', 'bilirubin total', 'tbili', 't bili', 'bili total', 'bili', 'bilirubin tot'],
  ggt: ['ggt', 'gamma glutamyl transferase', 'gamma gt', 'gamma glutamyltransferase', 'ggtp', 'gamma glutamyl transpeptidase'],
  // Inflammatory
  ferritin: ['ferritin', 'serum ferritin'],
  procalcitonin: ['procalcitonin', 'pct'],
  'il 6': ['il 6', 'il6', 'interleukin 6', 'interleukin 6 il 6'],
  // Autoimmune
  dsdna: ['dsdna', 'ds dna', 'anti dsdna', 'anti ds dna', 'double stranded dna', 'anti double stranded dna', 'dsdna antibody', 'dsdna ab', 'anti dsdna antibody', 'double stranded dna antibody', 'dsdna antibodies'],
  rf: ['rf', 'rheumatoid factor', 'rheumatoid factor rf', 'rheumatoid factor quantitative'],
  ccp: ['ccp', 'anti ccp', 'cyclic citrullinated peptide', 'anti cyclic citrullinated peptide', 'ccp antibody', 'anti ccp antibody', 'ccp ab', 'cyclic citrullinated peptide antibody', 'acpa', 'ccp igg'],
  anca: ['anca', 'anca screen', 'antineutrophil cytoplasmic antibody', 'anti neutrophil cytoplasmic antibody', 'antineutrophil cytoplasmic antibodies', 'anca panel'],
  c3: ['c3', 'complement c3', 'c3 complement', 'complement component 3', 'complement c3 c3', 'c3 complement component'],
  c4: ['c4', 'complement c4', 'c4 complement', 'complement component 4', 'complement c4 c4', 'c4 complement component'],
  'tpo antibody': ['tpo antibody', 'tpo', 'anti tpo', 'thyroid peroxidase antibody', 'thyroid peroxidase antibodies', 'thyroid peroxidase ab', 'tpo ab', 'anti tpo antibody', 'thyroperoxidase antibody', 'anti thyroid peroxidase', 'tpo antibodies'],
  // Neuro antibodies
  'nmdar antibody': ['nmdar antibody', 'nmdar', 'nmda receptor antibody', 'anti nmdar', 'anti nmda receptor', 'nmdar ab', 'anti nmdar antibody', 'nmda receptor ab', 'n methyl d aspartate receptor antibody', 'nmda antibody', 'anti nmda', 'nmdar igg', 'nmda receptor igg'],
  'lgi1 antibody': ['lgi1 antibody', 'lgi1', 'lgi 1', 'anti lgi1', 'lgi1 ab', 'lgi1 igg', 'leucine rich glioma inactivated 1 antibody', 'anti lgi1 antibody', 'lgi 1 antibody'],
  'caspr2 antibody': ['caspr2 antibody', 'caspr2', 'caspr 2', 'anti caspr2', 'caspr2 ab', 'caspr2 igg', 'contactin associated protein 2 antibody', 'anti caspr2 antibody', 'caspr 2 antibody'],
  'gad65 antibody': ['gad65 antibody', 'gad65', 'gad 65', 'anti gad65', 'anti gad', 'gad antibody', 'gad65 ab', 'glutamic acid decarboxylase antibody', 'glutamic acid decarboxylase 65 antibody', 'anti gad65 antibody', 'gad 65 antibody', 'gad antibodies'],
  'mog antibody': ['mog antibody', 'mog', 'anti mog', 'mog ab', 'mog igg', 'myelin oligodendrocyte glycoprotein antibody', 'anti mog antibody', 'mog antibodies'],
  'aqp4 antibody': ['aqp4 antibody', 'aqp4', 'aqp 4', 'anti aqp4', 'aqp4 ab', 'aqp4 igg', 'aquaporin 4 antibody', 'aquaporin 4', 'nmo antibody', 'nmo igg', 'anti aquaporin 4', 'aquaporin 4 igg', 'nmo ab', 'aqp 4 antibody'],
  // Immunoglobulins
  igg: ['igg', 'immunoglobulin g', 'igg quantitative', 'total igg', 'igg total', 'immunoglobulin g igg'],
  iga: ['iga', 'immunoglobulin a', 'iga quantitative', 'total iga', 'immunoglobulin a iga'],
  igm: ['igm', 'immunoglobulin m', 'igm quantitative', 'total igm', 'immunoglobulin m igm'],
  'kappa free light chains': ['kappa free light chains', 'kappa free light chain', 'kappa flc', 'free kappa light chains', 'kflc', 'free kappa', 'kappa light chains free', 'kappa free'],
  'lambda free light chains': ['lambda free light chains', 'lambda free light chain', 'lambda flc', 'free lambda light chains', 'lflc', 'free lambda', 'lambda light chains free', 'lambda free'],
  // Endocrine
  'free t4': ['free t4', 'ft4', 'free thyroxine', 't4 free', 'thyroxine free', 'free t4 ft4'],
  'free t3': ['free t3', 'ft3', 'free triiodothyronine', 't3 free', 'triiodothyronine free', 'free t3 ft3'],
  cortisol: ['cortisol', 'serum cortisol', 'am cortisol', 'cortisol am', 'morning cortisol', 'cortisol morning', 'cortisol total'],
  acth: ['acth', 'adrenocorticotropic hormone', 'corticotropin', 'adrenocorticotropin'],
  prolactin: ['prolactin', 'prl'],
  // Vitamins and nutrition
  folate: ['folate', 'folic acid', 'serum folate', 'folate serum', 'rbc folate', 'red cell folate'],
  'vitamin b1': ['vitamin b1', 'b1', 'thiamine', 'thiamin', 'vit b1', 'vitamin b 1', 'thiamine b1'],
  'vitamin b6': ['vitamin b6', 'b6', 'pyridoxine', 'vit b6', 'vitamin b 6', 'pyridoxal 5 phosphate', 'pyridoxal phosphate', 'plp', 'pyridoxine b6'],
  copper: ['copper', 'serum copper', 'cu', 'copper cu'],
  zinc: ['zinc', 'serum zinc', 'zn', 'zinc zn'],
  'methylmalonic acid': ['methylmalonic acid', 'mma', 'methylmalonate'],
  homocysteine: ['homocysteine', 'hcy', 'total homocysteine'],
  // Coagulation
  pt: ['pt', 'prothrombin time', 'protime', 'prothrombin time pt'],
  inr: ['inr', 'international normalized ratio', 'international normalised ratio', 'pt inr', 'inr pt'],
  ptt: ['ptt', 'aptt', 'partial thromboplastin time', 'activated partial thromboplastin time', 'aptt ptt'],
  fibrinogen: ['fibrinogen', 'fibrinogen activity', 'fibrinogen clauss'],
  'd dimer': ['d dimer', 'ddimer', 'dimer', 'd dimer quantitative', 'fibrin d dimer'],
  // Lipids
  cholesterol: ['cholesterol', 'total cholesterol', 'cholesterol total', 'chol', 'tc'],
  ldl: ['ldl', 'ldl cholesterol', 'ldl c', 'low density lipoprotein', 'low density lipoprotein cholesterol', 'ldl calculated', 'ldl direct'],
  hdl: ['hdl', 'hdl cholesterol', 'hdl c', 'high density lipoprotein', 'high density lipoprotein cholesterol'],
  triglycerides: ['triglycerides', 'triglyceride', 'tg', 'trig', 'trigs'],
};


// ---- frozen from d43790a src/server/services/labs.ts, ALIAS ... normalizeAnalyteUncached (labs.ts:327-412) ----

const ALIAS = new Map<string, string>();
for (const [canonical, list] of Object.entries(ANALYTE_SYNONYMS)) {
  ALIAS.set(canonical, canonical);
  for (const a of list) ALIAS.set(normalizeKey(a), canonical);
}

const LEAD_NOISE = ['serum', 'plasma', 'whole blood', 'blood', 'total'];
const TRAIL_NOISE = ['level', 'levels', 'serum', 'plasma', 'blood', 'result', 'results', 'value', 'titer', 'titre', 'screen', 'quantitative', 'qualitative', 'total', 'quant', 'qual', 'ser', 'sp'];

function stripNoise(key: string): string {
  let k = key;
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of LEAD_NOISE) {
      if (k.length > n.length && k.startsWith(`${n} `)) {
        k = k.slice(n.length + 1);
        changed = true;
      }
    }
    for (const n of TRAIL_NOISE) {
      if (k.length > n.length && k.endsWith(` ${n}`)) {
        k = k.slice(0, -(n.length + 1));
        changed = true;
      }
    }
  }
  return k.trim();
}

const CSF_TOKEN = /(^| )csf( |$)/;

function lookup(key: string, csf: boolean): string | null {
  if (!key) return null;
  // On a CSF specimen the CSF reading of a bare name wins ("WBC" is the cell count, not the blood count).
  if (csf) {
    const pre = ALIAS.get(`csf ${key}`);
    if (pre) return pre;
    const post = ALIAS.get(`${key} csf`);
    if (post) return post;
    // A known spelling that already names CSF ("CSF/serum albumin") means what it says.
    if (CSF_TOKEN.test(key)) {
      const direct = ALIAS.get(key);
      if (direct) return direct;
    }
    // Resolve the spelling first, then read its canonical key on CSF, so every spelling of one
    // study lands on one key ("Erythrocytes" -> rbc -> csf rbc, "Total WBC" -> wbc -> csf cell count).
    const bare = key.replace(/\bcsf\b/g, ' ').replace(/\s+/g, ' ').trim();
    const base = bare ? ALIAS.get(bare) : undefined;
    if (base) return ALIAS.get(`csf ${base}`) ?? ALIAS.get(`${base} csf`) ?? base;
  }
  return ALIAS.get(key) ?? null;
}

const NORMALIZE_MEMO = new Map<string, string>();

/**
 * The grouping key for an analyte name as written. Synonyms fold into one
 * canonical key; otherwise the normalised name minus noise words ("serum",
 * "level") is used. With `specimen` = csf, a bare "protein", "glucose",
 * "albumin", "WBC" or "RBC" is read as the CSF study of that name. Computed
 * when entries are read (never from the stored analyte_key), so a row made
 * before a spelling was known joins its test without being rewritten.
 */
function normalizeAnalyte(name: string | null | undefined, specimen?: string | null): string {
  // Read on every list, series and chart (1,000 rows and their parts): memoised per distinct name and specimen.
  const memoKey = `${specimen ?? ''}\u0001${name ?? ''}`;
  const hit = NORMALIZE_MEMO.get(memoKey);
  if (hit !== undefined) return hit;
  const out = normalizeAnalyteUncached(name, specimen);
  if (NORMALIZE_MEMO.size >= 20000) NORMALIZE_MEMO.clear();
  NORMALIZE_MEMO.set(memoKey, out);
  return out;
}

function normalizeAnalyteUncached(name: string | null | undefined, specimen?: string | null): string {
  let key = normalizeKey(name).replace(/\bcerebrospinal fluid\b/g, 'csf').replace(/\bspinal fluid\b/g, 'csf').replace(/\s+/g, ' ').trim();
  if (!key) return '';
  const csf = normalizeKey(specimen) === 'csf' || CSF_TOKEN.test(key);
  const direct = lookup(key, csf);
  if (direct) return direct;
  key = stripNoise(key);
  const stripped = lookup(key, csf);
  if (stripped) return stripped;
  return key;
}

// ---- frozen from d43790a src/server/services/labs.ts, isCsfOnlyKey ... BLOOD_SAMPLE (labs.ts:425-466) ----


/**
 * Tests that exist only in CSF: a key that names CSF ("csf protein"), the CSF indices, and the pressures measured at a
 * lumbar puncture. Read as CSF whatever specimen a row was saved with (a row typed by hand defaulted to serum), so
 * "Opening pressure" and "ICP (opening pressure)" are one test in one place.
 */
function isCsfOnlyKey(key: string): boolean {
  return key.startsWith('csf ') || CSF_ONLY_KEYS.has(key) || key === 'opening pressure' || key === 'closing pressure';
}

/**
 * The specimen an entry is listed under: CSF for a test that exists only in CSF, or when the name as written says the
 * sample is CSF ("CSF VDRL", "Lumbar puncture: …") and names no blood sample; else the specimen as saved. A row typed
 * by hand as "CSF VDRL" on the form's default (serum) is listed as CSF.
 */
function effectiveSpecimen(key: string, specimen: string, name?: string | null): string {
  if (isCsfOnlyKey(key)) return 'csf';
  // Only the word CSF in the name overrides a sample as saved: "Glucose at time of LP" stated as serum is the blood
  // glucose drawn beside the lumbar puncture, not a CSF value (a lumbar-puncture word decides an assumed sample only).
  if (name && namesCsfWord(name)) return 'csf';
  return specimen;
}

/** A name that says CSF ("CSF VDRL", "Protein, spinal fluid") and names no blood sample. */
function namesCsfWord(name: string | null | undefined): boolean {
  const k = nameKeyOf(name);
  return CSF_TOKEN.test(k) && !BLOOD_SAMPLE.test(k);
}

/** A name with "spinal fluid" read as "csf", normalised. */
function nameKeyOf(name: string | null | undefined): string {
  return normalizeKey(name).replace(/\b(?:cerebro)?spinal fluid\b/g, 'csf').replace(/\s+/g, ' ').trim();
}

/** A lumbar puncture named: "Lumbar puncture", "LP", "LP results", "Spinal tap" (never "Lp(a)" or "Lp-PLA2", blood tests). */
const LP_WORDS = /(?:^| )(?:lumbar puncture|spinal tap|lp(?! (?:a|pla2|pla 2|x|ir)(?: |$)))(?: |$)/;

/**
 * A name piece that names a blood sample ("serum", "plasma", "blood glucose", "fasting", "venous"): never "white blood
 * cells" or "blood count", which CSF has too.
 */
const BLOOD_SAMPLE = /\b(?:serum|plasma|whole blood|venous|arterial|capillary|fingerstick|finger stick|fasting|random)\b|\bblood\b(?! cells?\b| counts?\b)/;

// ---- frozen from d43790a src/server/services/labs.ts, CSF_ONLY_KEYS ... defaultSpecimenFor (labs.ts:1019-1040) ----

const CSF_ONLY_KEYS = new Set(['igg index', 'igg synthesis rate', 'albumin index']);

/**
 * Keys that are CSF studies when the report states no specimen. Not forced
 * like CSF_ONLY_KEYS: a serum OCB stated as such in a paired test stays serum.
 */
const CSF_DEFAULT_KEYS = new Set(['oligoclonal bands', 'opening pressure', 'closing pressure']);

/**
 * The specimen of an extracted result whose report did not state one: CSF
 * when the name says so ("IgG index, CSF", "spinal fluid protein") or names a
 * lumbar puncture ("Lumbar puncture", "LP", "LP results", "Spinal tap"), or the
 * study only exists in CSF (IgG index, Qalb, oligoclonal bands), else serum.
 */
function defaultSpecimenFor(analyte: string | null | undefined): 'csf' | 'serum' {
  const raw = nameKeyOf(analyte);
  const key = normalizeAnalyte(analyte);
  // A blood sample named ("Serum glucose at LP", "Blood glucose at time of LP") is blood, whatever else the name says,
  // unless the name also says CSF or the test only exists in CSF.
  if (BLOOD_SAMPLE.test(raw) && !CSF_TOKEN.test(raw) && !CSF_ONLY_KEYS.has(key)) return 'serum';
  return CSF_TOKEN.test(raw) || LP_WORDS.test(raw) || key.startsWith('csf ') || CSF_ONLY_KEYS.has(key) || CSF_DEFAULT_KEYS.has(key) ? 'csf' : 'serum';
}

// ---- frozen from d43790a src/server/services/labs.ts, parseNumeric ... deriveFlag (labs.ts:1071-1105) ----

function parseNumeric(s: string | number | null | undefined): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

function formatValue(e: { valueNum: number | null; valueText: string | null }): string {
  if (e.valueText && e.valueText.trim()) return e.valueText.trim();
  if (e.valueNum != null) return fmtNum(e.valueNum);
  return '';
}

function formatRef(e: { refLow: number | null; refHigh: number | null; refText: string | null }): string | null {
  if (e.refText && e.refText.trim()) return e.refText.trim();
  if (e.refLow != null && e.refHigh != null) return `${fmtNum(e.refLow)}–${fmtNum(e.refHigh)}`;
  if (e.refHigh != null) return `≤ ${fmtNum(e.refHigh)}`;
  if (e.refLow != null) return `≥ ${fmtNum(e.refLow)}`;
  return null;
}

/** H / L / N from a numeric value and its range; null when nothing can be said. */
function deriveFlag(valueNum: number | null, refLow: number | null, refHigh: number | null): 'H' | 'L' | 'N' | null {
  if (valueNum == null) return null;
  if (refHigh != null && valueNum > refHigh) return 'H';
  if (refLow != null && valueNum < refLow) return 'L';
  if (refLow != null || refHigh != null) return 'N';
  return null;
}

// ---- end of the frozen copy ----

/** The old Labs page's grouping key of a name on a sample (d43790a normalizeAnalyte). */
export function legacyNormalizeAnalyte(name: string | null | undefined, specimen?: string | null): string {
  return normalizeAnalyte(name, specimen);
}

/** The old default sample of a result whose report named none (d43790a defaultSpecimenFor). */
export function legacyDefaultSpecimenFor(analyte: string | null | undefined): 'csf' | 'serum' {
  return defaultSpecimenFor(analyte);
}

export { parseNumeric as legacyParseNumeric, formatValue as legacyFormatValue, formatRef as legacyFormatRef, deriveFlag as legacyDeriveFlag };

/** What the old Labs page showed for one value (one entry as stored, a line of several tests read whole). */
export interface LegacyView {
  /** The grouping key and the sample it was listed under. */
  key: string;
  specimen: string;
  /** The number it drew, judged and compared (null: not drawn). */
  measurement: number | null;
  /** The value as shown. */
  shown: string;
  /** The range as shown ("15–45", "≤ 50"), null when none. */
  range: string | null;
  /** The flag it was marked with: the stored flag, or "H~" / "L~" / "N~" worked out from the stored numbers. */
  flag: string | null;
  /** The date it was placed at. */
  date: string | null;
}

function view(e: { analyte: string; key: string; specimen: string; valueNum: number | null; valueText: string | null; refLow: number | null; refHigh: number | null; refText: string | null; reported: string | null; date: string | null }): LegacyView {
  const derived = e.reported ? null : deriveFlag(e.valueNum, e.refLow, e.refHigh);
  return {
    key: e.key,
    specimen: effectiveSpecimen(e.key, e.specimen, e.analyte),
    measurement: e.valueNum,
    shown: formatValue({ valueNum: e.valueNum, valueText: e.valueText }),
    range: formatRef({ refLow: e.refLow, refHigh: e.refHigh, refText: e.refText }),
    flag: e.reported ?? (derived ? `${derived}~` : null),
    date: e.date,
  };
}

/** A lab_results row as the old Labs page showed it (its own columns; readWholeLabEntries at d43790a). */
export function legacyRowView(r: { analyte: string; specimen: string; valueNum: number | null; valueText: string | null; refLow: number | null; refHigh: number | null; refText: string | null; flag: string | null; collectedAt: string | null }): LegacyView {
  const key = normalizeAnalyte(r.analyte, r.specimen);
  return view({ analyte: r.analyte, key, specimen: r.specimen, valueNum: r.valueNum, valueText: r.valueText, refLow: r.refLow, refHigh: r.refHigh, refText: r.refText, reported: r.flag ?? null, date: r.collectedAt });
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A lab_result fact not imported yet as the old Labs page showed it (factEntry at d43790a). */
export function legacyFactView(f: { attributesJson: string; date: string | null; subjectKey?: string | null; statement?: string | null }): LegacyView {
  const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
  const analyte = str(a.analyte) ?? (f.subjectKey?.split('|')[1]?.trim() || (f.statement ?? '').slice(0, 80));
  const stated = str(a.specimen);
  const specimen = stated ?? defaultSpecimenFor(analyte);
  const key = normalizeAnalyte(analyte, specimen);
  const valueNum = num(a.value_num) ?? parseNumeric((a.value as string | null | undefined) ?? null);
  return view({ analyte, key, specimen, valueNum, valueText: str(a.value), refLow: num(a.ref_low), refHigh: num(a.ref_high), refText: str(a.ref_text), reported: str(a.flag), date: f.date });
}

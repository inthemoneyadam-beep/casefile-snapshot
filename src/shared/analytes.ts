/**
 * Analyte names: the audited synonym table, labels, the specimen helpers and the analyte matcher. Pure (no DB, no
 * Node, no React), shared by the server and the browser. Moved from src/server/services/labs.ts (lab values as printed,
 * 2026-10, the user's rule 9) and audited:
 * - a name that states a blood sample ("Serum albumin", "Blood glucose", "IgG, serum") is never read as a CSF test,
 *   whatever specimen the row was saved with;
 * - spellings that name different tests are no longer folded into one key (hs-CRP is not CRP, an absolute count is
 *   not a percentage, Qalb is not the albumin index, a corrected CSF count is not the raw count, urea is not BUN...);
 * - noise stripping keeps words that name different results (titer, screen, quantitative, qualitative);
 * - matchAnalyte never returns a test that is not exactly the one asked for: a vague or unknown name returns no rows
 *   and names the similar tests on file.
 * The opening pressure = ICP = OP = LP pressure fold and the CSF cell-count spellings are deliberate (the user's request,
 * DECISIONS.md 2007) and stay.
 */
import { normalizeKey } from './text';

/** canonical key -> every spelling that means the same test (all normalised with normalizeKey). */
export const ANALYTE_SYNONYMS: Record<string, string[]> = {
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
    // A raw count is the count as printed (the value text keeps the word "raw"). A corrected count (for blood in the
    // sample) is a different result: 'csf cell count corrected' below (rule 9, 2026-10).
    'csf nucleated', 'csf nucleated cell', 'csf nucleated cell count', 'csf total nucleated cells',
    'csf wbc raw', 'csf raw wbc', 'csf cell count raw', 'csf leucocytes', 'csf leukocyte count', 'csf white count', 'csf wbcs',
  ],
  'csf cell count corrected': ['csf cell count corrected', 'csf wbc corrected', 'wbc csf corrected', 'csf corrected wbc', 'corrected wbc csf', 'csf corrected cell count'],
  'csf rbc': [
    'csf rbc', 'rbc csf', 'csf red blood cells', 'red blood cells csf', 'csf red cell count', 'csf red cells', 'csf rbc count', 'csf erythrocytes', 'erythrocytes csf', 'csf red blood cell count',
    'csf rbcs', 'csf red cell', 'csf erythrocyte count',
  ],
  'igg index': ['igg index', 'csf igg index', 'igg index csf', 'csf serum igg index', 'igg idx'],
  // "IgG synthesis" alone is often a sentence about synthesis, not the rate: it keeps its own name.
  'igg synthesis rate': ['igg synthesis rate', 'csf igg synthesis rate', 'intrathecal igg synthesis rate', 'igg synth rate', 'igg synthesis rate csf'],
  // The albumin index (CSF mg/dL / serum g/dL) and the albumin quotient Qalb (the same ratio printed x10^-3, or raw,
  // judged by an age-dependent limit) are printed on different scales: two tests, never one series. "Albumin ratio"
  // (also the urine albumin/creatinine ratio) and "CSF/serum albumin" (could be the paired serum albumin) keep their names.
  'albumin index': [
    'albumin index', 'csf serum albumin ratio', 'csf serum albumin index', 'csf albumin ratio', 'csf albumin index', 'albumin csf serum ratio', 'albumin index csf',
  ],
  'albumin quotient': ['albumin quotient', 'qalb', 'q alb', 'q albumin', 'csf serum albumin quotient', 'csf albumin quotient', 'albumin quotient csf'],
  'oligoclonal bands': [
    'oligoclonal bands', 'ocb', 'ocbs', 'oligoclonal banding', 'oligoclonal band', 'csf oligoclonal bands', 'oligoclonal bands csf', 'o bands', 'oligoclonal', 'oligoclonal igg bands', 'csf ocb',
    'csf ocbs', 'ocb csf', 'csf oligoclonal igg bands', 'oligoclonal igg bands csf', 'csf oligoclonal banding', 'csf restricted oligoclonal bands', 'csf specific oligoclonal bands',
    'unique csf oligoclonal bands', 'csf oligoclonal band',
  ],
  esr: ['esr', 'sed rate', 'sedimentation rate', 'erythrocyte sedimentation rate', 'westergren', 'westergren esr', 'esr westergren', 'erythrocyte sed rate'],
  crp: ['crp', 'c reactive protein', 'creactive protein'],
  // hs-CRP is a different assay with its own range (mg/L, cardiac risk): its own test.
  'hs crp': ['hs crp', 'hscrp', 'high sensitivity crp', 'high sensitivity c reactive protein', 'c reactive protein high sensitivity', 'crp high sensitivity'],
  ana: ['ana', 'antinuclear antibody', 'antinuclear antibodies', 'anti nuclear antibody', 'anti nuclear antibodies', 'ana screen', 'ana ifa', 'antinuclear ab'],
  // The titer and the pattern are separate results of an ANA, not the screen.
  'ana titer': ['ana titer', 'ana titre'],
  'ana pattern': ['ana pattern'],
  tsh: ['tsh', 'thyroid stimulating hormone', 'thyrotropin', 'thyroid stimulating hormone tsh', 'tsh 3rd generation', 'tsh third generation'],
  'vitamin b12': ['vitamin b12', 'b12', 'vit b12', 'cobalamin', 'cyanocobalamin', 'b 12', 'vitamin b 12', 'vitamin b12 cobalamin'],
  'vitamin d': [
    'vitamin d', 'vit d', '25 oh vitamin d', '25 hydroxyvitamin d', '25 hydroxy vitamin d', '25 oh d', '25ohd', 'vitamin d 25 hydroxy', 'calcidiol', 'vitamin d 25 oh',
    'vitamin d total', 'vitamin d 25 hydroxy total', '25 hydroxyvitamin d total', 'vit d 25 oh', 'vitamin d 25 oh total', '25 hydroxy vitamin d total',
  ],
  // D3 alone is one part of the total 25-OH vitamin D.
  'vitamin d3': ['vitamin d3', '25 oh d3'],
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
    'glucose ratio csf serum', 'csf glucose serum glucose ratio',
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
  rdw: ['rdw', 'red cell distribution width', 'red blood cell distribution width'],
  // RDW-CV (%) and RDW-SD (fL) are two measures with two units and two ranges.
  'rdw cv': ['rdw cv'],
  'rdw sd': ['rdw sd'],
  mpv: ['mpv', 'mean platelet volume'],
  // A white-cell type as a share of the white cells (%) and as an absolute count (x10^3/uL) are two results.
  neutrophils: ['neutrophils', 'neutrophil', 'segmented neutrophils', 'segs', 'polys'],
  // "Neutrophil count" is printed for the count (x10^3/uL), not the share (%): a test of its own, never the percentage.
  'neutrophil count': ['neutrophil count', 'neutrophils count'],
  'neutrophils absolute': ['neutrophils absolute', 'absolute neutrophil count', 'anc', 'abs neutrophils', 'absolute neutrophils', 'neutrophils abs', 'neut abs', 'neutrophil absolute'],
  lymphocytes: ['lymphocytes', 'lymphocyte', 'lymphs'],
  'lymphocyte count': ['lymphocyte count', 'lymphocytes count'],
  'lymphocytes absolute': ['lymphocytes absolute', 'absolute lymphocyte count', 'alc', 'abs lymphocytes', 'absolute lymphocytes', 'lymphocytes abs', 'lymphs abs', 'lymph abs'],
  monocytes: ['monocytes', 'monocyte', 'monos'],
  'monocyte count': ['monocyte count', 'monocytes count'],
  'monocytes absolute': ['monocytes absolute', 'absolute monocyte count', 'abs monocytes', 'absolute monocytes', 'monocytes abs', 'mono abs'],
  eosinophils: ['eosinophils', 'eosinophil', 'eos'],
  'eosinophil count': ['eosinophil count', 'eosinophils count'],
  'eosinophils absolute': ['eosinophils absolute', 'absolute eosinophil count', 'abs eosinophils', 'absolute eosinophils', 'eosinophils abs', 'eos abs'],
  basophils: ['basophils', 'basophil', 'basos'],
  'basophil count': ['basophil count', 'basophils count'],
  'basophils absolute': ['basophils absolute', 'absolute basophil count', 'abs basophils', 'absolute basophils', 'basophils abs', 'baso abs'],
  // Metabolic
  sodium: ['sodium', 'na', 'sodium na', 'serum sodium'],
  potassium: ['potassium', 'k', 'potassium k', 'serum potassium'],
  chloride: ['chloride', 'cl', 'chloride cl', 'serum chloride'],
  co2: ['co2', 'bicarbonate', 'hco3', 'carbon dioxide', 'total co2', 'co2 total', 'bicarb', 'tco2', 'carbon dioxide total', 'co2 content'],
  bun: ['bun', 'blood urea nitrogen', 'urea nitrogen', 'urea nitrogen bun', 'bun urea nitrogen'],
  // Urea (mmol/L) is not urea nitrogen (BUN, mg/dL): a different number for the same substance.
  urea: ['urea'],
  creatinine: ['creatinine', 'creat', 'cr', 'serum creatinine', 'creatinine serum', 'creatinine cr'],
  egfr: ['egfr', 'estimated gfr', 'gfr estimated', 'estimated glomerular filtration rate'],
  // A bare "GFR" does not say whether it was estimated or measured (rule 9): its own test, never folded into either.
  gfr: ['gfr', 'glomerular filtration rate'],
  // A named equation gives its own number (the 2021 CKD-EPI equation is not the 2009 one, nor MDRD), and a measured GFR
  // (a clearance) is not an estimate: each is a test of its own, so a change of equation never reads as a trend.
  'egfr ckd epi 2021': ['egfr ckd epi 2021', 'ckd epi 2021', 'egfr 2021 ckd epi', 'egfr ckd epi 2021 race free', 'egfr cr ckd epi 2021'],
  'egfr ckd epi': ['egfr ckd epi', 'ckd epi egfr', 'egfr ckd epi 2009', 'ckd epi 2009'],
  'egfr mdrd': ['egfr mdrd', 'mdrd egfr', 'mdrd gfr', 'gfr mdrd'],
  'measured gfr': ['measured gfr', 'mgfr', 'gfr measured', 'measured glomerular filtration rate', 'iohexol gfr', 'gfr iohexol'],
  // The two race-based estimates printed side by side are two different numbers.
  'egfr african american': ['egfr african american'],
  'egfr non african american': ['egfr non african american'],
  glucose: ['glucose', 'blood glucose', 'plasma glucose', 'glucose fasting', 'fasting glucose', 'glucose random', 'random glucose', 'glu', 'fasting blood glucose', 'fbg', 'fasting plasma glucose'],
  calcium: ['calcium', 'ca', 'total calcium', 'calcium total', 'serum calcium', 'calcium ca'],
  magnesium: ['magnesium', 'mg', 'serum magnesium', 'magnesium mg'],
  phosphorus: ['phosphorus', 'phosphate', 'phos', 'inorganic phosphorus', 'phosphorus inorganic', 'po4', 'phosphorous', 'inorganic phosphate'],
  albumin: ['albumin', 'serum albumin', 'alb', 'albumin alb'],
  // A bare "Protein" keeps its own name (on a CSF sample it still reads as CSF protein through lookup).
  'total protein': ['total protein', 'protein total', 'tp', 'serum total protein', 'serum protein', 'protein tp'],
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
  folate: ['folate', 'folic acid', 'serum folate', 'folate serum'],
  // Red-cell folate is measured in red cells, with its own range.
  'rbc folate': ['rbc folate', 'red cell folate', 'red blood cell folate', 'folate rbc'],
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
  ldl: ['ldl', 'ldl cholesterol', 'ldl c', 'low density lipoprotein', 'low density lipoprotein cholesterol', 'ldl calculated'],
  // A directly measured LDL is a different method from the calculated one.
  'ldl direct': ['ldl direct', 'direct ldl'],
  hdl: ['hdl', 'hdl cholesterol', 'hdl c', 'high density lipoprotein', 'high density lipoprotein cholesterol'],
  triglycerides: ['triglycerides', 'triglyceride', 'tg', 'trig', 'trigs'],
};

/** Display labels for canonical keys; other keys are shown as written. */
export const ANALYTE_LABELS: Record<string, string> = {
  wbc: 'WBC',
  rbc: 'RBC',
  'csf protein': 'CSF protein',
  'csf glucose': 'CSF glucose',
  'csf albumin': 'CSF albumin',
  'csf cell count': 'CSF cell count',
  'csf cell count corrected': 'CSF cell count (corrected)',
  'csf rbc': 'CSF RBC',
  'igg index': 'IgG index',
  'igg synthesis rate': 'IgG synthesis rate',
  'albumin index': 'Albumin index',
  'albumin quotient': 'Albumin quotient (Qalb)',
  'oligoclonal bands': 'Oligoclonal bands',
  esr: 'ESR',
  crp: 'CRP',
  'hs crp': 'hs-CRP',
  ana: 'ANA',
  'ana titer': 'ANA titer',
  'ana pattern': 'ANA pattern',
  tsh: 'TSH',
  'vitamin b12': 'Vitamin B12',
  'vitamin d': 'Vitamin D (25-OH)',
  'vitamin d3': 'Vitamin D3',
  'opening pressure': 'Opening pressure',
  'closing pressure': 'Closing pressure',
  'csf appearance': 'CSF appearance',
  'csf color': 'CSF color',
  'csf xanthochromia': 'CSF xanthochromia',
  'csf lactate': 'CSF lactate',
  'csf ldh': 'CSF LDH',
  'csf serum glucose ratio': 'CSF/serum glucose ratio',
  'csf myelin basic protein': 'CSF myelin basic protein',
  'csf cytology': 'CSF cytology',
  'csf culture': 'CSF culture',
  'csf gram stain': 'CSF Gram stain',
  'csf ace': 'CSF ACE',
  ace: 'ACE',
  'hsv pcr': 'HSV PCR',
  'vzv pcr': 'VZV PCR',
  'enterovirus pcr': 'Enterovirus PCR',
  'cryptococcal antigen': 'Cryptococcal antigen',
  vdrl: 'VDRL',
  'meningitis encephalitis panel': 'Meningitis/encephalitis panel',
  'csf igg': 'CSF IgG',
  'csf kappa free light chains': 'CSF kappa free light chains',
  hemoglobin: 'Hemoglobin',
  hematocrit: 'Hematocrit',
  platelets: 'Platelets',
  mcv: 'MCV',
  mch: 'MCH',
  mchc: 'MCHC',
  rdw: 'RDW',
  'rdw cv': 'RDW-CV',
  'rdw sd': 'RDW-SD',
  mpv: 'MPV',
  neutrophils: 'Neutrophils',
  'neutrophils absolute': 'Neutrophils (absolute)',
  'neutrophil count': 'Neutrophil count',
  lymphocytes: 'Lymphocytes',
  'lymphocytes absolute': 'Lymphocytes (absolute)',
  'lymphocyte count': 'Lymphocyte count',
  monocytes: 'Monocytes',
  'monocytes absolute': 'Monocytes (absolute)',
  'monocyte count': 'Monocyte count',
  eosinophils: 'Eosinophils',
  'eosinophils absolute': 'Eosinophils (absolute)',
  'eosinophil count': 'Eosinophil count',
  basophils: 'Basophils',
  'basophils absolute': 'Basophils (absolute)',
  'basophil count': 'Basophil count',
  sodium: 'Sodium',
  potassium: 'Potassium',
  chloride: 'Chloride',
  co2: 'CO2 (bicarbonate)',
  bun: 'BUN',
  urea: 'Urea',
  creatinine: 'Creatinine',
  egfr: 'eGFR',
  'egfr african american': 'eGFR (African American)',
  'egfr non african american': 'eGFR (non-African American)',
  'egfr ckd epi 2021': 'eGFR (CKD-EPI 2021)',
  'egfr ckd epi': 'eGFR (CKD-EPI)',
  'egfr mdrd': 'eGFR (MDRD)',
  'measured gfr': 'Measured GFR',
  gfr: 'GFR',
  glucose: 'Glucose',
  calcium: 'Calcium',
  magnesium: 'Magnesium',
  phosphorus: 'Phosphorus',
  albumin: 'Albumin',
  'total protein': 'Total protein',
  ast: 'AST',
  alt: 'ALT',
  'alkaline phosphatase': 'Alkaline phosphatase',
  bilirubin: 'Bilirubin',
  ggt: 'GGT',
  ferritin: 'Ferritin',
  procalcitonin: 'Procalcitonin',
  'il 6': 'IL-6',
  dsdna: 'dsDNA antibody',
  rf: 'Rheumatoid factor',
  ccp: 'CCP antibody',
  anca: 'ANCA',
  c3: 'Complement C3',
  c4: 'Complement C4',
  'tpo antibody': 'TPO antibody',
  'nmdar antibody': 'NMDAR antibody',
  'lgi1 antibody': 'LGI1 antibody',
  'caspr2 antibody': 'CASPR2 antibody',
  'gad65 antibody': 'GAD65 antibody',
  'mog antibody': 'MOG antibody',
  'aqp4 antibody': 'AQP4 antibody',
  igg: 'IgG',
  iga: 'IgA',
  igm: 'IgM',
  'kappa free light chains': 'Kappa free light chains',
  'lambda free light chains': 'Lambda free light chains',
  'free t4': 'Free T4',
  'free t3': 'Free T3',
  cortisol: 'Cortisol',
  acth: 'ACTH',
  prolactin: 'Prolactin',
  folate: 'Folate',
  'rbc folate': 'RBC folate',
  'vitamin b1': 'Vitamin B1 (thiamine)',
  'vitamin b6': 'Vitamin B6',
  copper: 'Copper',
  zinc: 'Zinc',
  'methylmalonic acid': 'Methylmalonic acid',
  homocysteine: 'Homocysteine',
  pt: 'PT',
  inr: 'INR',
  ptt: 'PTT',
  fibrinogen: 'Fibrinogen',
  'd dimer': 'D-dimer',
  cholesterol: 'Total cholesterol',
  ldl: 'LDL cholesterol',
  'ldl direct': 'LDL cholesterol (direct)',
  hdl: 'HDL cholesterol',
  triglycerides: 'Triglycerides',
};


/** Every spelling (normalised) -> its canonical key. */
export const ALIAS = new Map<string, string>();
for (const [canonical, list] of Object.entries(ANALYTE_SYNONYMS)) {
  ALIAS.set(canonical, canonical);
  for (const a of list) ALIAS.set(normalizeKey(a), canonical);
}

export const LEAD_NOISE = ['serum', 'plasma', 'whole blood', 'blood', 'total'];
/**
 * Words dropped from the end of a name that is not in the table. Never a word that names a different result: "titer",
 * "screen", "quantitative" and "qualitative" stay ("CMV PCR quantitative" is not "CMV PCR qualitative"; rule 9).
 */
export const TRAIL_NOISE = ['level', 'levels', 'serum', 'plasma', 'blood', 'result', 'results', 'value', 'total', 'ser', 'sp'];

export function stripNoise(key: string): string {
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

export const CSF_TOKEN = /(^| )csf( |$)/;

/**
 * A name piece that names a blood sample ("serum", "plasma", "blood glucose", "fasting", "venous"): never "white blood
 * cells" or "blood count", which CSF has too.
 */
export const BLOOD_SAMPLE = /\b(?:serum|plasma|whole blood|venous|arterial|capillary|fingerstick|finger stick|fasting|random)\b|\bblood\b(?! cells?\b| counts?\b)/;

export function lookup(key: string, csf: boolean): string | null {
  if (!key) return null;
  // On a CSF specimen the CSF reading of a bare name wins ("WBC" is the cell count, not the blood count).
  if (csf) {
    const pre = ALIAS.get(`csf ${key}`);
    if (pre) return pre;
    const post = ALIAS.get(`${key} csf`);
    if (post) return post;
    // A known spelling that already names CSF ("CSF/serum albumin ratio") means what it says.
    if (CSF_TOKEN.test(key)) {
      const direct = ALIAS.get(key);
      if (direct) return direct;
    }
    // Resolve the spelling first, then read its canonical key on CSF, so every spelling of one
    // study lands on one key ("Erythrocytes" -> rbc -> csf rbc, "Total WBC" -> wbc -> csf cell count).
    // Never through a blood sample word: "CSF/blood glucose" is the paired blood glucose (or a ratio), not CSF glucose.
    const bare = key.replace(/\bcsf\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (bare && !BLOOD_SAMPLE.test(bare)) {
      // "CSF protein, CSF": the bare name read on CSF ("protein" -> csf protein; a bare "protein" is no longer a spelling of total protein).
      const onCsf = ALIAS.get(`csf ${bare}`) ?? ALIAS.get(`${bare} csf`);
      if (onCsf) return onCsf;
      const base = ALIAS.get(bare);
      if (base) return ALIAS.get(`csf ${base}`) ?? ALIAS.get(`${base} csf`) ?? base;
    }
  }
  return ALIAS.get(key) ?? null;
}

export const NORMALIZE_MEMO = new Map<string, string>();

/** Empties the analyte-name memo (names as written in the record); the server calls it when the case locks. */
export function clearNormalizeMemo(): void {
  NORMALIZE_MEMO.clear();
}

/**
 * The grouping key for an analyte name as written. Synonyms fold into one
 * canonical key; otherwise the normalised name minus noise words ("serum",
 * "level") is used. With `specimen` = csf, a bare "protein", "glucose",
 * "albumin", "WBC" or "RBC" is read as the CSF study of that name. Computed
 * when entries are read (never from the stored analyte_key), so a row made
 * before a spelling was known joins its test without being rewritten.
 *
 * A name that states a blood sample and does not say CSF ("Serum albumin", "Blood glucose", "IgG, serum") is never
 * read as a CSF study, whatever specimen the row was saved with: "Serum albumin" on a CSF panel is albumin, not the
 * albumin index. When such a name would still land on a CSF study ("Serum oligoclonal bands"), the key keeps the
 * sample ("serum oligoclonal bands"). The CSF/serum indices (IgG index, albumin index, Qalb) stay what they are.
 */
export function normalizeAnalyte(name: string | null | undefined, specimen?: string | null): string {
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
  const written = nameKeyOf(name);
  if (!written) return '';
  const bloodNamed = BLOOD_SAMPLE.test(written) && !CSF_TOKEN.test(written);
  const csf = !bloodNamed && (normalizeKey(specimen) === 'csf' || CSF_TOKEN.test(written));
  const stripped = stripNoise(written);
  const out = lookup(written, csf) ?? lookup(stripped, csf) ?? stripped;
  if (bloodNamed && !CSF_ONLY_KEYS.has(out) && (out.startsWith('csf ') || CSF_DEFAULT_KEYS.has(out))) {
    // A blood sample named on a test that is otherwise read as a CSF study: the sample stays in the key.
    const base = stripped.startsWith('csf ') ? stripped.slice(4) : stripped;
    return `${bloodWordOf(written)} ${base}`;
  }
  return out;
}

/** The blood sample a name states, as one word for a key: "serum", "plasma", "whole blood", else "blood". */
function bloodWordOf(k: string): string {
  if (/\bwhole blood\b/.test(k)) return 'whole blood';
  if (/\bplasma\b/.test(k)) return 'plasma';
  if (/\bserum\b/.test(k)) return 'serum';
  return 'blood';
}

/** Human label for a key: the canonical label, else the name as most often written. */
export function analyteLabel(key: string, asWritten?: string | null): string {
  return ANALYTE_LABELS[key] ?? (asWritten?.trim() || key);
}

export const SPECIMEN_LABELS: Record<string, string> = { serum: 'serum', plasma: 'plasma', whole_blood: 'whole blood', csf: 'CSF', urine: 'urine', other: 'other' };

/** A key the synonym table knows (a canonical key), not a name kept as written. */
export function isKnownKey(key: string): boolean {
  return Boolean(key) && Object.prototype.hasOwnProperty.call(ANALYTE_SYNONYMS, key);
}

/** Keys that only exist as CSF studies, whatever specimen a row claims (the CSF/serum indices). */
export const CSF_ONLY_KEYS = new Set(['igg index', 'igg synthesis rate', 'albumin index', 'albumin quotient']);

/**
 * Keys that are CSF studies when the report states no specimen. Not forced
 * like CSF_ONLY_KEYS: a serum OCB stated as such in a paired test stays serum.
 */
export const CSF_DEFAULT_KEYS = new Set(['oligoclonal bands', 'opening pressure', 'closing pressure']);

/**
 * Tests that exist only in CSF: a key that names CSF ("csf protein"), the CSF indices, and the pressures measured at a
 * lumbar puncture. Read as CSF whatever specimen a row was saved with (a row typed by hand defaulted to serum), so
 * "Opening pressure" and "ICP (opening pressure)" are one test in one place.
 */
export function isCsfOnlyKey(key: string): boolean {
  return key.startsWith('csf ') || CSF_ONLY_KEYS.has(key) || key === 'opening pressure' || key === 'closing pressure';
}

const BLOOD_SPECIMENS = new Set(['serum', 'plasma', 'whole_blood']);

/**
 * The specimen an entry is listed under: CSF for a test that exists only in CSF, or when the name as written says the
 * sample is CSF ("CSF VDRL", "Lumbar puncture: …") and names no blood sample; a blood sample when the name states one
 * and does not say CSF ("Serum albumin" saved on a CSF panel is listed under serum; a row already saved on a blood
 * sample keeps it); else the specimen as saved. A row typed by hand as "CSF VDRL" on the form's default (serum) is
 * listed as CSF.
 */
export function effectiveSpecimen(key: string, specimen: string, name?: string | null): string {
  if (isCsfOnlyKey(key)) return 'csf';
  if (name) {
    const k = nameKeyOf(name);
    const csfWord = CSF_TOKEN.test(k);
    const bloodWord = BLOOD_SAMPLE.test(k);
    if (bloodWord && !csfWord) return BLOOD_SPECIMENS.has(specimen) ? specimen : bloodSpecimenOf(k);
    // Only the word CSF in the name overrides a sample as saved: "Glucose at time of LP" stated as serum is the blood
    // glucose drawn beside the lumbar puncture, not a CSF value (a lumbar-puncture word decides an assumed sample only).
    if (csfWord && !bloodWord) return 'csf';
  }
  return specimen;
}

/** The blood specimen a name states: plasma, whole blood, else serum. */
function bloodSpecimenOf(k: string): string {
  if (/\bplasma\b/.test(k)) return 'plasma';
  if (/\bwhole blood\b/.test(k)) return 'whole_blood';
  return 'serum';
}

/** A name with "spinal fluid" read as "csf", normalised. */
export function nameKeyOf(name: string | null | undefined): string {
  return normalizeKey(name).replace(/\b(?:cerebro)?spinal fluid\b/g, 'csf').replace(/\s+/g, ' ').trim();
}

/** A lumbar puncture named: "Lumbar puncture", "LP", "LP results", "Spinal tap" (never "Lp(a)" or "Lp-PLA2", blood tests). */
export const LP_WORDS = /(?:^| )(?:lumbar puncture|spinal tap|lp(?! (?:a|pla2|pla 2|x|ir)(?: |$)))(?: |$)/;

/** A name that says its sample is CSF (or a lumbar puncture) and names no blood sample. */
export function namesCsfSample(name: string | null | undefined): boolean {
  const k = nameKeyOf(name);
  return (CSF_TOKEN.test(k) || LP_WORDS.test(k)) && !BLOOD_SAMPLE.test(k);
}

/**
 * The specimen of an extracted result whose report did not state one: CSF
 * when the name says so ("IgG index, CSF", "spinal fluid protein") or names a
 * lumbar puncture ("Lumbar puncture", "LP", "LP results", "Spinal tap"), or the
 * study only exists in CSF (IgG index, Qalb, oligoclonal bands), else serum.
 */
export function defaultSpecimenFor(analyte: string | null | undefined): 'csf' | 'serum' {
  const raw = nameKeyOf(analyte);
  const key = normalizeAnalyte(analyte);
  // A blood sample named ("Serum glucose at LP", "Blood glucose at time of LP") is blood, whatever else the name says,
  // unless the name also says CSF or the test only exists in CSF.
  if (BLOOD_SAMPLE.test(raw) && !CSF_TOKEN.test(raw) && !CSF_ONLY_KEYS.has(key)) return 'serum';
  return CSF_TOKEN.test(raw) || LP_WORDS.test(raw) || key.startsWith('csf ') || CSF_ONLY_KEYS.has(key) || CSF_DEFAULT_KEYS.has(key) ? 'csf' : 'serum';
}

// ---------------------------------------------------------------------------
// Different tests with similar names (rule 9), and the matcher
// ---------------------------------------------------------------------------

/**
 * Different tests with similar names: never one test, never matched for one another. Used by matchAnalyte to name
 * the similar tests on file, and by a test that no spelling of one member folds into another.
 */
export const LOOKALIKE_FAMILIES: readonly (readonly string[])[] = [
  ['igg', 'csf igg', 'igg index', 'igg synthesis rate', 'csf igg albumin ratio'],
  ['albumin', 'csf albumin', 'albumin index', 'albumin quotient'],
  ['glucose', 'csf glucose', 'csf serum glucose ratio'],
  ['total protein', 'csf protein', 'protein'],
  ['crp', 'hs crp'],
  ['folate', 'rbc folate'],
  ['vitamin d', 'vitamin d3'],
  ['ana', 'ana titer', 'ana pattern'],
  ['wbc', 'csf cell count', 'csf cell count corrected'],
  ['rbc', 'csf rbc'],
  ['rdw', 'rdw cv', 'rdw sd'],
  ['bun', 'urea'],
  ['ldl', 'ldl direct'],
  ['egfr', 'egfr african american', 'egfr non african american', 'egfr ckd epi 2021', 'egfr ckd epi', 'egfr mdrd', 'measured gfr', 'gfr'],
  ['neutrophils', 'neutrophils absolute', 'neutrophil count'],
  ['lymphocytes', 'lymphocytes absolute', 'lymphocyte count'],
  ['monocytes', 'monocytes absolute', 'monocyte count'],
  ['eosinophils', 'eosinophils absolute', 'eosinophil count'],
  ['basophils', 'basophils absolute', 'basophil count'],
];

/** The other members of every lookalike family a key belongs to. */
export function lookalikesOf(key: string): string[] {
  const out = new Set<string>();
  for (const fam of LOOKALIKE_FAMILIES) if (fam.includes(key)) for (const k of fam) if (k !== key) out.add(k);
  return [...out];
}

export type AnalyteMatch =
  | { status: 'exact'; key: string; via: 'canonical' | 'synonym' | 'as written'; alsoOnFile: string[]; reason: string | null }
  | { status: 'ambiguous'; key: null; candidates: string[]; reason: string }
  /** candidates: similar tests on file (different tests, named for the reader); possibly empty. Never rows. */
  | { status: 'none'; key: null; candidates: string[]; reason: string };

function listWords(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Which test on file a name asks for. Never returns a key that is not exactly the query's own: "IgG" never answers
 * with the IgG index, "IgG index" never with serum IgG.
 * - exact: the query's own key is on file (alsoOnFile names similar, different tests also on file).
 * - ambiguous: no test has that key, and tests whose names contain every word of the query are on file ("IgG" with
 *   IgG index, IgG synthesis rate and CSF IgG on file): the query is too vague. No rows.
 * - none: no test with that key is on file (similar tests on file, if any, are named in the reason). No rows.
 * `known`: the analyte keys on file (with their specimen).
 */
export function matchAnalyte(query: string, known: Iterable<{ key: string; specimen: string }>, opts: { specimen?: string | null } = {}): AnalyteMatch {
  const keys = new Set<string>();
  for (const k of known) if (k.key) keys.add(k.key);
  const asked = (query ?? '').trim();
  const key = normalizeAnalyte(asked, opts.specimen ?? null);
  if (!key) return { status: 'none', key: null, candidates: [], reason: 'No test name was given.' };
  const label = (k: string) => analyteLabel(k);
  const family = lookalikesOf(key).filter((k) => keys.has(k));
  if (keys.has(key)) {
    const written = nameKeyOf(asked);
    const via: 'canonical' | 'synonym' | 'as written' = !isKnownKey(key) ? 'as written' : written === key ? 'canonical' : 'synonym';
    const also = family.sort();
    const reason = also.length ? `${listWords(also.map(label))} ${also.length === 1 ? 'is a different test' : 'are different tests'}, also on file; not included.` : null;
    return { status: 'exact', key, via, alsoOnFile: also, reason };
  }
  const tokens = key.split(' ').filter(Boolean);
  const containing = [...keys].filter((k) => {
    if (k === key) return false;
    const kt = new Set(k.split(' '));
    return tokens.every((t) => kt.has(t));
  });
  if (containing.length) {
    const candidates = [...new Set([...containing, ...family])].sort();
    return {
      status: 'ambiguous',
      key: null,
      candidates,
      reason: `No test is called "${asked}". Different tests with similar names are on file: ${candidates.map(label).join(', ')}. Ask for one of them by name.`,
    };
  }
  if (family.length) {
    const sorted = family.sort();
    return {
      status: 'none',
      key: null,
      candidates: sorted,
      reason: `No test called "${asked}" is on file. ${listWords(sorted.map(label))} ${sorted.length === 1 ? 'is a different test' : 'are different tests'} with a similar name; not used for "${asked}".`,
    };
  }
  return { status: 'none', key: null, candidates: [], reason: `No test called "${asked}" is on file.` };
}

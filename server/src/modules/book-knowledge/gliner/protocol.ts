export const GLINER_LABELS = ['concept or idea', 'theory or hypothesis', 'technology', 'person or character', 'field of study'];
export const GLINER_THRESHOLD = 0.4;
// Python treats four ASCII separator controls as whitespace in addition to Unicode White_Space.
// eslint-disable-next-line no-control-regex
export const PYTHON_NON_SPACE = /[^\p{White_Space}\u001c-\u001f]/u;

export interface GlinerSpan {
  start: number;
  end: number;
  text: string;
  label: string;
  score: number;
}

export interface GlinerRunner {
  predict(text: string, labels: readonly string[], threshold: number): Promise<GlinerSpan[]>;
  release(): Promise<void>;
}

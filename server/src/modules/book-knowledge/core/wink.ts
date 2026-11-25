import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

// The model's metaCER loader re-stringifies its own cached result on every call, so each new instance makes it
// about four times larger and a process dies after some 18 instances. Load it once and hand every instance that copy.
const metaCER = (model.metaCER as () => unknown)();
const stableModel = { ...model, metaCER: () => metaCER };

// wink-nlp adds every unseen word to the instance's lexicon and keeps a known word whole, so once "It was Name’s." is
// read, every later "Name’s" stays one token. Use a new instance for each pass over a book; never share one.
export function createWinkNlp(pipe?: string[]): ReturnType<typeof winkNLP> {
  return winkNLP(stableModel, pipe);
}

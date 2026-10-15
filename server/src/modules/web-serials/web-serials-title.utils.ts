const CONTRACTION_AFTER_APOSTROPHE = /(\p{Ll})(['’])(S|T|D|M|Re|Ve|Ll)(?!\p{L})/gu;

/**
 * Some sources title-case every word, which turns "Journey's" into "Journey'S". A contraction ending that was
 * capitalised after a lowercase letter is such an artifact. Capitals inside a name ("O'Brien") and all-caps
 * titles ("DON'T STOP") are left as the source wrote them.
 */
export function fixApostropheCase(title: string): string {
  return title.replace(
    CONTRACTION_AFTER_APOSTROPHE,
    (_match, before: string, apostrophe: string, ending: string) => `${before}${apostrophe}${ending.toLowerCase()}`,
  );
}

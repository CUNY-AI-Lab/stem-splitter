/**
 * What a genre list leaves out. Someone browsing "country" did not ask for this material, so it stays out of their list.
 * A search naming the artist or title still finds it, because a course may need to study it.
 * This is a policy list: edit it freely. Spelling and capitals do not matter. Entries match whole words.
 *
 * Before adding an entry, check that it cannot catch something else. Names also match titles, so "No Remorse"
 * would hide a Metallica song. Leave out words people reclaim, because hiding them would mostly remove those
 * artists' own work, and words with innocent uses, which real bands and ordinary phrases share.
 */

/** Tags uploaders put on this music themselves. They reach far more of the Archive than any list of bands. */
export const HATE_MUSIC_TAGS = [
  'RAC', 'Rechtsrock', 'Rock Against Communism', 'White Power', 'White Pride', 'White Supremacy', 'White Supremacist',
  'White Nationalist', 'White Nationalism', 'Neo Nazi', 'Neonazi', 'Nazi Rock', 'Nazi Punk', 'Naziband', 'Hate Rock',
  'Hatecore', 'Patriotic Rock', 'White Youth Music', 'NSBM', 'National Socialist Black Metal', 'NS Black Metal', 'Ku Klux Klan',
];

/** For uploads that carry none of those tags. Only names distinctive enough to match in a title. */
export const HATE_MUSIC_NAMES = ['Skrewdriver', 'Landser', 'Lunikoff', 'Stahlgewitter', 'Johnny Rebel', 'RAHOWA', 'Redneck 28', 'Lynchkapelle'];

export const SLURS = [
  'nigger',
  'niggers',
  'kike',
  'kikes',
  'wetback',
  'wetbacks',
  'raghead',
  'ragheads',
  'towelhead',
  'towelheads',
  'jigaboo',
  'zipperhead',
  'zipperheads',
];

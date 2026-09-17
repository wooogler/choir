/**
 * Name dictionary for anonymization
 * Contains pools of fake names for generating anonymized identities
 */

export const FAKE_FIRST_NAMES = [
  'John',
  'Jane',
  'Alex',
  'Sam',
  'Chris',
  'Taylor',
  'Jordan',
  'Casey',
  'Morgan',
  'Riley',
  'Avery',
  'Drew',
  'Quinn',
  'Sage',
  'Rowan',
  'Emery',
  'Finley',
  'Hayden',
  'Peyton',
  'Reese',
  'Blake',
  'Cameron',
  'Dakota',
  'Elliot',
  'Frankie',
  'Hunter',
  'Kai',
  'Logan',
  'Parker',
  'River',
];

export const FAKE_LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
];

/**
 * Hangul pseudonym pool. A Latin pseudonym dropped into Korean text is a giveaway
 * that a name was masked and reads badly to the model, so Hangul real names get a
 * Hangul pseudonym. Surname and given name are fused with no space, exactly like a
 * real Korean name, and the given name doubles as the nickname.
 */
export const FAKE_KOREAN_SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오'];

export const FAKE_KOREAN_GIVEN_NAMES = [
  '민준',
  '서연',
  '지후',
  '하윤',
  '도윤',
  '시우',
  '예준',
  '수아',
  '지민',
  '유진',
  '현우',
  '은서',
  '준호',
  '다은',
  '세연',
  '태윤',
  '주원',
  '하람',
  '나윤',
];

/**
 * Generate a unique fake name combination. `preferKorean` picks the Hangul pool so
 * the pseudonym matches the script of the real name.
 */
export function generateFakeName(
  usedNames: Set<string>,
  preferKorean = false,
): { fakeName: string; fakeNickname: string } {
  const [firstPool, lastPool, join] = preferKorean
    ? ([FAKE_KOREAN_GIVEN_NAMES, FAKE_KOREAN_SURNAMES, ''] as const)
    : ([FAKE_FIRST_NAMES, FAKE_LAST_NAMES, ' '] as const);

  // Korean order is surname + given name; Latin order is given name + surname.
  const compose = (given: string, family: string) =>
    preferKorean ? `${family}${join}${given}` : `${given}${join}${family}`;

  let attempts = 0;
  while (attempts < 100) {
    const firstName = firstPool[Math.floor(Math.random() * firstPool.length)];
    const lastName = lastPool[Math.floor(Math.random() * lastPool.length)];
    const fakeName = compose(firstName, lastName);

    if (!usedNames.has(fakeName)) {
      return { fakeName, fakeNickname: firstName };
    }
    attempts++;
  }

  // Fallback if all combinations are used
  const timestamp = Date.now();
  const firstName = firstPool[0];
  const lastName = lastPool[0];
  return {
    fakeName: `${compose(firstName, lastName)}${timestamp}`,
    fakeNickname: firstName,
  };
}

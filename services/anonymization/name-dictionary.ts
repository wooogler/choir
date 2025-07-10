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
 * Generate a unique fake name combination
 */
export function generateFakeName(usedNames: Set<string>): { fakeName: string; fakeNickname: string } {
  let attempts = 0;
  while (attempts < 100) {
    const firstName = FAKE_FIRST_NAMES[Math.floor(Math.random() * FAKE_FIRST_NAMES.length)];
    const lastName = FAKE_LAST_NAMES[Math.floor(Math.random() * FAKE_LAST_NAMES.length)];
    const fakeName = `${firstName} ${lastName}`;

    if (!usedNames.has(fakeName)) {
      return { fakeName, fakeNickname: firstName };
    }
    attempts++;
  }

  // Fallback if all combinations are used
  const timestamp = Date.now();
  const firstName = FAKE_FIRST_NAMES[0];
  const lastName = FAKE_LAST_NAMES[0];
  return {
    fakeName: `${firstName} ${lastName}${timestamp}`,
    fakeNickname: firstName,
  };
}
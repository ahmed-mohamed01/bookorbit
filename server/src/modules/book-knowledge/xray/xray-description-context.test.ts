import { proseProblem } from './xray-description-context';

describe('fiction prose checks', () => {
  it('accepts flowing prose and counts commas per sentence', () => {
    expect(
      proseProblem(
        "A ship's cook from the coast who woke in a dead queen's body, Tavia now leads the river clans with the stone guardian Orrin at her side.",
      ),
    ).toBeNull();
    expect(proseProblem('At dawn, she repairs ropes, sails, and oars. At dusk, she takes the ferry home.')).toBeNull();
  });

  it('rejects four commas in one sentence', () => {
    expect(proseProblem('A cook, a queen, a mage, a scout, and a sailor.')).toBe('list');
  });

  it.each(['+1', '-2', 'level 5', 'Beginner 2', 'Intermediate 1', 'Novice 3', 'Apprentice 1', 'Expert 4', 'Master 5'])(
    'rejects stat numbers such as %s',
    (stat) => {
      expect(proseProblem(`With Orrin at her side, she gains ${stat}.`)).toBe('stat-numbers');
    },
  );
});

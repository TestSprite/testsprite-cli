import { describe, expect, it } from 'vitest';
import { answersFor, optionLetter } from './answers.js';
import type { Question } from './types.js';

const questions: Question[] = [
  {
    question: 'What should I work on next?',
    header: 'Next',
    options: [
      { label: 'Round 5', description: 'Tunnels, test lists and schedules.' },
      { label: 'Write routes', description: 'Create, update and delete.' },
    ],
    multiSelect: false,
  },
  {
    question: 'Which of these are bugs?',
    header: 'Bugs',
    options: [
      { label: 'The 204', description: '' },
      { label: 'The 400', description: '' },
      { label: 'The 201', description: '' },
    ],
    multiSelect: true,
  },
];

describe('answersFor', () => {
  it("turns letters into the options' labels, several joined as the portal joins them", () => {
    expect(answersFor(questions, ['1=b', '2=a,c'])).toEqual({
      'What should I work on next?': 'Write routes',
      'Which of these are bugs?': 'The 204, The 201',
    });
    expect(answersFor(questions, ['2= A , a ', '1=a'])['Which of these are bugs?']).toBe('The 204');
  });

  it("keeps the user's own words as the answer", () => {
    expect(answersFor(questions, ['1=the sign-in flow, nothing else', '2=none of them'])).toEqual({
      'What should I work on next?': 'the sign-in flow, nothing else',
      'Which of these are bugs?': 'none of them',
    });
  });

  it.each([
    [[], /Answer questions 1, 2 too/],
    [['1=a'], /Answer question 2 too: `testsprite apply --answer 1=<choice> --answer 2=<choice>`/],
    [['3=a', '1=a', '2=a'], /questions are numbered 1 to 2/],
    [['x=a', '1=a', '2=a'], /questions are numbered 1 to 2/],
    [['1=c', '2=a'], /question 1 has options a to b/],
    [['1=a,b', '2=a'], /question 1 takes one option/],
    [['1=', '2=a'], /give an option's letter or your own words/],
    [['1=a', '1=b', '2=a'], /question 1 is answered twice/],
  ])('refuses %j, so the card keeps waiting', (given, message) => {
    expect(() => answersFor(questions, given)).toThrow(message);
    expect(() => answersFor(questions, given)).toThrow(expect.objectContaining({ exitCode: 5 }));
  });

  it('letters the options a, b, c…', () => {
    expect([0, 1, 25].map(optionLetter)).toEqual(['a', 'b', 'z']);
  });
});

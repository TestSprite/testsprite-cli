import { CLIError } from '../errors.js';
import type { Question } from './types.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const LETTER_LIST = /^[a-z](\s*,\s*[a-z])*$/i;

export const optionLetter = (index: number): string => LETTERS[index] ?? String(index + 1);

const invalid = (message: string) => new CLIError(message, 5, 'VALIDATION_ERROR');

/**
 * The answers `apply --answer <n>=<choice>` gives a question card, keyed by
 * each question's text as the portal's card sends them: an option's label,
 * several labels joined by ", " when the question takes several, or the
 * user's own words. Every question needs an answer, or the card keeps waiting.
 */
export function answersFor(questions: Question[], given: string[]): Record<string, string> {
  const answers = new Map<number, string>();
  for (const raw of given) {
    const at = raw.indexOf('=');
    const index = at > 0 ? Number(raw.slice(0, at).trim()) : NaN;
    const choice = at > 0 ? raw.slice(at + 1).trim() : '';
    if (!Number.isInteger(index) || index < 1 || index > questions.length) {
      throw invalid(
        `--answer ${raw}: questions are numbered 1 to ${questions.length}, as \`testsprite apply --answer <n>=<choice>\`.`,
      );
    }
    if (!choice) throw invalid(`--answer ${raw}: give an option's letter or your own words.`);
    if (answers.has(index)) throw invalid(`--answer ${raw}: question ${index} is answered twice.`);
    answers.set(index, answerTo(questions[index - 1]!, index, choice, raw));
  }
  const unanswered = questions.map((_, i) => i + 1).filter(n => !answers.has(n));
  if (unanswered.length) {
    throw invalid(
      `Answer ${unanswered.length === 1 ? 'question' : 'questions'} ${unanswered.join(', ')} too: \`testsprite apply ${questions.map((_, i) => `--answer ${i + 1}=<choice>`).join(' ')}\`. The card keeps waiting.`,
    );
  }
  return Object.fromEntries(questions.map((q, i) => [q.question, answers.get(i + 1)!]));
}

function answerTo(question: Question, index: number, choice: string, raw: string): string {
  if (!LETTER_LIST.test(choice)) return choice;
  const letters = choice.split(',').map(l => l.trim().toLowerCase());
  const last = optionLetter(question.options.length - 1);
  const labels = letters.map(letter => {
    const option = question.options[LETTERS.indexOf(letter)];
    if (!option) throw invalid(`--answer ${raw}: question ${index} has options a to ${last}.`);
    return option.label;
  });
  if (labels.length > 1 && !question.multiSelect) {
    throw invalid(`--answer ${raw}: question ${index} takes one option.`);
  }
  return [...new Set(labels)].join(', ');
}

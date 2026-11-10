import { describe, expect, it } from 'vitest';
import { askedForLine, findSecret, secretTitle, secretVars } from './agentSecrets';

describe('findSecret', () => {
  it('spots common key shapes and names them', () => {
    const cases: [string, string, string][] = [
      ['use sk_live_51HxAbCdEfGhIjKlMnOp for it', 'sk_live_51HxAbCdEfGhIjKlMnOp', 'stripe_key'],
      [
        'ghp_0123456789abcdefghijABCDEFGHIJ012345',
        'ghp_0123456789abcdefghijABCDEFGHIJ012345',
        'github_token',
      ],
      [
        'key sk-ant-api03-abcdefghijklmnopqrstuv',
        'sk-ant-api03-abcdefghijklmnopqrstuv',
        'anthropic_key',
      ],
      ['sk-proj-abcdefghijklmnopqrstuvwx', 'sk-proj-abcdefghijklmnopqrstuvwx', 'openai_key'],
      ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE', 'aws_access_key_id'],
      ['password: hunter2hunter2', 'hunter2hunter2', 'credential'],
    ];
    for (const [text, value, name] of cases) {
      expect(findSecret(text)).toMatchObject({ value, name });
    }
  });

  it('leaves ordinary messages alone', () => {
    for (const text of [
      'Can you check the Stripe payouts?',
      'the token count went up',
      'set the password field to required',
      'sk_live is the prefix',
    ]) {
      expect(findSecret(text)).toBeNull();
    }
  });
});

describe('secretTitle', () => {
  it('says the identifier as words', () => {
    expect(secretTitle('stripe_key')).toBe('Stripe key');
    expect(secretTitle('bank-login')).toBe('Bank login');
    expect(secretTitle('GitHub')).toBe('GitHub');
  });

  it('keeps initialisms and brand capitals, never a raw identifier', () => {
    expect(secretTitle('crm_api_key')).toBe('CRM API key');
    expect(secretTitle('GITHUB_TOKEN')).toBe('GitHub token');
    expect(secretTitle('chat_bot_token')).toBe('Chat bot token');
    expect(secretTitle('QuickBooks-login')).toBe('QuickBooks login');
  });
});

describe('secretVars', () => {
  it('lists every variable', () => {
    expect(
      secretVars({
        fields: [
          { label: 'Username', env: 'BANK_USERNAME' },
          { label: 'Password', env: 'BANK_PASSWORD' },
        ],
      })
    ).toBe('$BANK_USERNAME, $BANK_PASSWORD');
  });
});

describe('askedForLine', () => {
  it('stays quiet when the title already says what the agent called it', () => {
    expect(askedForLine('gmail_work', 'Recruiter needs your Gmail (work)')).toBeNull();
  });
  it('says it when the title names something else', () => {
    expect(askedForLine('payroll_mail', 'Recruiter needs your Gmail')).toBe(
      'Asked for “Payroll mail”'
    );
  });
  it('says nothing without a name', () => {
    expect(askedForLine(undefined, 'Recruiter needs your Gmail')).toBeNull();
  });
});

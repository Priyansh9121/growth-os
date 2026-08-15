/**
 * Login form — accessibility and behaviour.
 *
 * WHAT THESE TESTS PROTECT
 * The accessibility commitments in `docs/design/login-experience.md` §7. They
 * are written as CI gates rather than a checklist because a11y regressions are
 * invisible to the person who causes them — nothing looks broken.
 *
 * @see docs/design/login-experience.md
 * @see docs/design/accessibility.md
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from './login-form';
import { AuthTransitionProvider } from '../auth-transition/provider';

// The provider derives its initial phase from the route.
vi.mock('next/navigation', () => ({
  usePathname: () => '/login',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function renderLogin() {
  return render(
    <AuthTransitionProvider>
      <LoginForm />
    </AuthTransitionProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true, redirectTo: '/dashboard' }), { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('labelling', () => {
  it('exposes both fields by their visible label', () => {
    renderLogin();
    // getByLabelText fails unless a real <label for> association exists. A
    // placeholder-only field would not be found here — which is the point.
    expect(screen.getByLabelText(/^Email/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toBeInTheDocument();
  });

  it('does not rely on placeholders as labels', () => {
    renderLogin();
    const email = screen.getByLabelText(/^Email/);
    // A placeholder may exist as a hint, but the accessible name must come
    // from the label — placeholders vanish on input and are inconsistently
    // announced.
    expect(email).toHaveAccessibleName();
  });

  it('marks required fields for assistive technology', () => {
    renderLogin();
    expect(screen.getByLabelText(/^Email/)).toBeRequired();
    expect(screen.getByLabelText(/^Password/)).toBeRequired();
  });
});

describe('keyboard operation', () => {
  it('reaches every control in a sensible order with Tab alone', async () => {
    const user = userEvent.setup();
    renderLogin();

    // Email is autofocused, so the cursor is already where typing should go.
    expect(screen.getByLabelText(/^Email/)).toHaveFocus();

    await user.tab();
    expect(screen.getByLabelText(/^Password/)).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: /show password/i })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toHaveFocus();
  });

  it('submits with Enter from a text field', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/^Email/), 'sam@abcplumbing.test');
    await user.type(screen.getByLabelText(/^Password/), 'a-valid-test-password{Enter}');

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
  });
});

describe('password reveal', () => {
  it('is a real button whose accessible name reflects its state', async () => {
    const user = userEvent.setup();
    renderLogin();

    const toggle = screen.getByRole('button', { name: /show password/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'password');

    await user.click(toggle);

    expect(screen.getByRole('button', { name: /hide password/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'text');
  });
});

describe('validation', () => {
  it('announces a field error and links it to the input', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/^Email/), 'not-an-email');
    await user.type(screen.getByLabelText(/^Password/), 'a-valid-test-password');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    const email = screen.getByLabelText(/^Email/);
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));

    // aria-describedby must point at the rendered error, or the message is
    // visible but never announced.
    const describedBy = email.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(/valid email/i);
  });

  it('does not submit invalid input', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/^Email/), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('authentication failure', () => {
  it('announces the error with role="alert" and returns focus to the form', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'authentication_error', message: 'Email or password is incorrect.' },
        }),
        { status: 401 },
      ),
    );

    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/^Email/), 'sam@abcplumbing.test');
    await user.type(screen.getByLabelText(/^Password/), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/email or password is incorrect/i);

    // Focus returns so a keyboard user can retry without hunting.
    await waitFor(() => expect(screen.getByLabelText(/^Email/)).toHaveFocus());
  });

  it('re-enables the form after a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 }),
    );

    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/^Email/), 'sam@abcplumbing.test');
    await user.type(screen.getByLabelText(/^Password/), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByLabelText(/^Email/)).toBeEnabled());
  });
});

describe('submitting state', () => {
  it('marks the form busy and renames the submit control', async () => {
    // A never-resolving fetch holds the form in its submitting state.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    const user = userEvent.setup();
    const { container } = renderLogin();

    await user.type(screen.getByLabelText(/^Email/), 'sam@abcplumbing.test');
    await user.type(screen.getByLabelText(/^Password/), 'a-valid-test-password');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => {
      expect(container.querySelector('form')).toHaveAttribute('aria-busy', 'true');
    });

    // The button keeps its accessible name updated rather than becoming an
    // anonymous spinner, and stays focusable (aria-disabled, not disabled) so
    // a screen-reader user is not dropped to the top of the document.
    const button = screen.getByRole('button', { name: /signing in/i });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });
});

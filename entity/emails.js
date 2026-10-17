// The emails accounts send: subject, plain text and HTML for each. No I/O, so they are easy to test.

function escape_html(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// One short message with an optional button. Inline styles only: mail clients drop <style>.
function layout({name, paragraphs, action, footer}) {
    const greeting = `Hi ${name},`;
    const text = [greeting, ...paragraphs];
    const html = [`<p>${escape_html(greeting)}</p>`, ...paragraphs.map(function (p) {
        return `<p>${escape_html(p)}</p>`;
    })];
    if (action) {
        text.push(`${action.label}: ${action.url}`);
        html.push(
            `<p><a href="${escape_html(action.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;` +
            `background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600">${escape_html(action.label)}</a></p>`,
            `<p style="color:#64748b;font-size:13px">Or paste this link into your browser: ${escape_html(action.url)}</p>`
        );
    }
    text.push(footer, '— Sequence');
    html.push(`<p style="color:#64748b;font-size:13px">${escape_html(footer)}</p>`, '<p>— Sequence</p>');
    return {
        text: text.join('\n\n'),
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#0f172a">${html.join('')}</div>`,
    };
}

function verify_email({name, url, hours}) {
    return Object.assign({subject: 'Confirm your email for Sequence'}, layout({
        name,
        paragraphs: ['Confirm this is your email address to finish setting up your Sequence account.'],
        action: {label: 'Confirm email', url},
        footer: `The link works for ${hours} hours. If you didn't sign up for Sequence, ignore this email.`,
    }));
}

function reset_password({name, url, minutes}) {
    return Object.assign({subject: 'Reset your Sequence password'}, layout({
        name,
        paragraphs: ['Someone asked to reset the password of your Sequence account. Choose a new one here:'],
        action: {label: 'Choose a new password', url},
        footer: `The link works once, for ${minutes} minutes. If you didn't ask for it, ignore this email: your ` +
            'password stays as it is.',
    }));
}

function password_changed({name}) {
    return Object.assign({subject: 'Your Sequence password was changed'}, layout({
        name,
        paragraphs: ['The password of your Sequence account was just changed, and every device was signed out.'],
        footer: "If that wasn't you, reset your password straight away from the sign-in page.",
    }));
}

// Someone tried to sign up with an email that already has an account. The sign-up looks successful to them, so
// nobody can find out which emails are registered; the owner learns about it here.
function existing_account({name, handle, sign_in_url}) {
    return Object.assign({subject: 'You already have a Sequence account'}, layout({
        name,
        paragraphs: [
            `Someone tried to create a Sequence account with this email, but it already belongs to the handle ` +
            `"${handle}". Sign in with that handle, or reset your password from the sign-in page if you forgot it.`,
        ],
        action: {label: 'Sign in', url: sign_in_url},
        footer: "If it wasn't you, you can ignore this email.",
    }));
}

// Sent to the current address when the player asks to move their account to another one.
function approve_email_change({name, new_email, url, hours}) {
    return Object.assign({subject: 'Approve the new email for your Sequence account'}, layout({
        name,
        paragraphs: [
            `Someone signed in to your Sequence account asked to change its email to ${new_email}. If that was you, ` +
            'approve it here; we will then send a link to the new address to confirm it.',
        ],
        action: {label: 'Approve the change', url},
        footer: `The link works for ${hours} hours. If it wasn't you, ignore this email and change your password: ` +
            'your email stays as it is.',
    }));
}

module.exports = {escape_html, verify_email, reset_password, password_changed, existing_account, approve_email_change};

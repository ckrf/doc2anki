'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';

type FriendsResponse = { emails?: string[]; error?: string };

export default function AdminPage() {
  const [emails, setEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function readResponse(response: Response) {
    const payload = await response.json() as FriendsResponse;
    if (!response.ok || !payload.emails) throw new Error(payload.error || 'The access list could not be updated.');
    setEmails(payload.emails);
  }

  useEffect(() => {
    void fetch('/api/admin/friends')
      .then(readResponse)
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'The access list could not be loaded.'))
      .finally(() => setLoading(false));
  }, []);

  async function addFriend(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await readResponse(await fetch('/api/admin/friends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail }),
      }));
      setNewEmail('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That friend could not be added.');
    } finally {
      setSaving(false);
    }
  }

  async function removeFriend(email: string) {
    if (!window.confirm(`Remove ${email} from Doc2Anki?`)) return;
    setSaving(true);
    setError('');
    try {
      await readResponse(await fetch('/api/admin/friends', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That friend could not be removed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="admin-shell">
      <header className="topbar admin-topbar">
        <div className="brand-mark">D</div>
        <div className="brand-copy"><strong>Doc2Anki</strong><span>Administration</span></div>
        <Link className="source-button" href="/">Back to cards</Link>
      </header>
      <section className="admin-panel">
        <div className="eyebrow">Access</div>
        <h1>Friends</h1>
        <p>Add an email address here and that person can immediately request a one-time login code.</p>
        <form className="admin-add" onSubmit={addFriend}>
          <label htmlFor="friend-email">Friend’s email</label>
          <div><input id="friend-email" type="email" required value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="friend@example.com" /><button className="primary-button" disabled={saving}>Add friend</button></div>
        </form>
        {error && <div className="message error-message" role="alert"><strong>Something needs attention</strong>{error}</div>}
        <div className="friends-list" aria-busy={loading || saving}>
          {loading ? <p>Loading access list…</p> : emails.map((email) => (
            <div key={email}><span>{email}</span><button onClick={() => removeFriend(email)} disabled={saving}>Remove</button></div>
          ))}
        </div>
      </section>
    </main>
  );
}

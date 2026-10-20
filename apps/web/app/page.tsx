import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** Entry point: the dashboard when signed in, otherwise the sign-in page. */
export default async function Home() {
  const user = await currentUser();
  if (!user) redirect('/login');
  redirect(user.passwordSetupRequired ? '/set-password' : '/dashboard');
}

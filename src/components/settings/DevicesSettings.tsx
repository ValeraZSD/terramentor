import OtherDevices from '../OtherDevices';
import SecuritySettings from '../SecuritySettings';
import { useStore } from '../../store';

/** Settings → Devices & security: which other devices open this app, and the
 *  password. One section because each answers the other: a connected phone
 *  needs no password, and a password changes what Tailscale lets in. A library
 *  on a site has neither: any device signs in at the site's address. */
export default function DevicesSettings({ active }: { active: boolean }) {
    const authSite = useStore(s => s.authSite);
    return (
        <div className={active ? '' : 'hidden'}>
            {!authSite && <OtherDevices active={active} />}
            <SecuritySettings />
        </div>
    );
}

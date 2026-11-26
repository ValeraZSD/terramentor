import OtherDevices from '../OtherDevices';
import SecuritySettings from '../SecuritySettings';
import { clientExtension } from '../../clientExtension';

/** Settings → Devices & security: which other devices open this app, and the
 *  password. One section because each answers the other: a connected phone
 *  needs no password, and a password changes what Tailscale lets in. A client
 *  extension may put its own panel in either place (src/clientExtension.ts). */
export default function DevicesSettings({ active }: { active: boolean }) {
    const Devices = clientExtension.DevicesPanel;
    const own = <OtherDevices active={active} />;
    return (
        <div className={active ? '' : 'hidden'}>
            {Devices ? <Devices fallback={own} /> : own}
            <SecuritySettings />
        </div>
    );
}

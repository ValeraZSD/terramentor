import OtherDevices from '../OtherDevices';
import SecuritySettings from '../SecuritySettings';

/** Settings → Devices & security: which other devices open this app, and the
 *  password. One section because each answers the other: a connected phone
 *  needs no password, and a password changes what Tailscale lets in. */
export default function DevicesSettings({ active }: { active: boolean }) {
    return (
        <div className={active ? '' : 'hidden'}>
            <OtherDevices active={active} />
            <SecuritySettings />
        </div>
    );
}

import React, { useState } from 'react'

export function AccountAvatar({ url, initial, fallbackClassName }: { url?: string; initial: string; fallbackClassName?: string }): React.JSX.Element {
    const [failedUrl, setFailedUrl] = useState<string | null>(null)
    return url && url !== failedUrl
        ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
        : <span className={fallbackClassName} aria-hidden="true">{initial}</span>
}

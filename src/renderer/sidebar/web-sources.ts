export interface AnswerSource { title: string; url: string; domain: string }
export function webSources(text: string): { text: string; sources: AnswerSource[] } {
    const marker = '\n\n<!-- web-sources -->\n'
    const [body, appendix] = text.split(marker)
    const sources = new Map<string, AnswerSource>()
    const link = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
    const add = (label: string, url: string): void => {
        try {
            const domain = new URL(url).hostname
            const title = /^\d+$/.test(label) ? domain : label
            if (!sources.has(url) || sources.get(url)?.title === domain) sources.set(url, { title, url, domain })
        } catch { /* Ignore malformed URLs. */ }
    }
    if (appendix) for (const match of appendix.matchAll(link)) add(match[1], match[2])
    const parts = body.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    const cleaned = parts.map((part, index) => {
        if (index % 2) return part
        return part.split('\n').map(line => {
            const sourceLine = /^\s*(?:[-*]\s+)?\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*$/.test(line)
            return line.replace(link, (original, label: string, url: string) => {
                if (!appendix && !sourceLine && !/^\d+$/.test(label)) return original
                add(label, url)
                return sourceLine || /^\d+$/.test(label) ? '' : label
            }).replace(/\s+([.,;:!?])/g, '$1')
        }).join('\n')
    }).join('')
    return { text: cleaned.trim(), sources: [...sources.values()] }
}

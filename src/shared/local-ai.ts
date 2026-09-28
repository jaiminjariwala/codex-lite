export interface LocalAIStatus {
    phase: 'idle' | 'installing' | 'starting' | 'downloading' | 'ready' | 'paused' | 'error'
    message: string
    percent?: number
}
// One multimodal model avoids keeping separate text and vision weights in RAM.
export const LOCAL_MODEL = 'qwen3.5:9b'
export const LOCAL_VISION_MODEL = LOCAL_MODEL

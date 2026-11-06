import numpy as np
import soundfile as sf
import torch
import torchaudio
from scipy import signal

sample_rate = 16000
n_fft = 800
hop_size = 200
win_size = 800
num_mels = 80
fmin = 55
fmax = 7600
ref_level_db = 20
min_level_db = -100

def load_wav(path, sr=sample_rate):
    wav, orig_sr = sf.read(path)
    if len(wav.shape) > 1:
        wav = wav.mean(axis=1) # Convert stereo to mono
    if orig_sr != sr:
        tensor_wav = torch.tensor(wav, dtype=torch.float32).unsqueeze(0)
        resampler = torchaudio.transforms.Resample(orig_sr, sr)
        wav = resampler(tensor_wav).squeeze(0).numpy()
    return wav.astype(np.float32)

def preemphasis(wav, k=0.97):
    return signal.lfilter([1, -k], [1], wav)

def _amp_to_db(x):
    min_level = np.exp(min_level_db / 20 * np.log(10))
    return 20 * np.log10(np.maximum(min_level, x))

def _normalize(S):
    return np.clip((2 * S - min_level_db) / (ref_level_db - min_level_db) - 1, -1, 1)

_mel_basis_transform = torchaudio.transforms.MelSpectrogram(
    sample_rate=sample_rate,
    n_fft=n_fft,
    win_length=win_size,
    hop_length=hop_size,
    n_mels=num_mels,
    f_min=fmin,
    f_max=fmax,
    power=1.0,
    center=True
)

def melspectrogram(wav):
    filtered_wav = preemphasis(wav)
    t_wav = torch.tensor(filtered_wav, dtype=torch.float32).unsqueeze(0)
    mel = _mel_basis_transform(t_wav).squeeze(0).numpy()
    S = _amp_to_db(mel) - ref_level_db
    return _normalize(S)

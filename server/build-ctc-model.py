# Builds Sabaq's fast speech model (server/models/pc/model.int8.onnx + tokens.txt) from NVIDIA's own checkpoint.
# NVIDIA's Arabic FastConformer (stt_ar_fastconformer_hybrid_large_pc_v1.0, CC-BY-4.0) is a hybrid model; its
# encoder is published as ONNX (LukeJacob2023/sherpa-onnx-stt_ar_fastconformer_hybrid_large_pc), its CTC head only
# in the .nemo checkpoint. This joins the two into one CTC model and quantises it to 8 bits (sherpa-onnx's format).
#
#   pip install onnx onnxruntime numpy pyyaml
#   mkdir -p models/pc && cd models/pc
#   curl -L -o nvidia.nemo https://huggingface.co/nvidia/stt_ar_fastconformer_hybrid_large_pc_v1.0/resolve/main/stt_ar_fastconformer_hybrid_large_pc_v1.0.nemo
#   curl -L -o encoder.onnx https://huggingface.co/LukeJacob2023/sherpa-onnx-stt_ar_fastconformer_hybrid_large_pc/resolve/main/encoder.onnx
#   curl -L -o tokens.txt https://huggingface.co/LukeJacob2023/sherpa-onnx-stt_ar_fastconformer_hybrid_large_pc/resolve/main/tokens.txt
#   tar xf nvidia.nemo ./model_config.yaml ./model_weights.ckpt
#   python ../../build-ctc-model.py
#
# (checked: the result reads 108 ayahs by 4 qaris word for word like the model Sabaq used before)
import zipfile, pickle, collections, numpy as np, onnx, yaml, sys
from onnx import helper, numpy_helper, TensorProto
z = zipfile.ZipFile('model_weights.ckpt'); pre = z.namelist()[0].split('/')[0]
class U(pickle.Unpickler):
    def find_class(s, mod, name):
        if name == '_rebuild_tensor_v2': return lambda st, off, size, stride, *r: ('T', st, off, size, stride)
        if mod == 'collections' and name == 'OrderedDict': return collections.OrderedDict
        if mod.startswith('torch'):
            class C:
                def __init__(self, *a, **k): pass
            C.__name__ = name; return C
        return super().find_class(mod, name)
    def persistent_load(s, pid): return pid
sd = U(z.open(pre + '/data.pkl')).load()
def tensor(k):
    _, st, off, size, stride = sd[k]; assert st[1].__name__ == 'FloatStorage', st
    a = np.frombuffer(z.read(f'{pre}/data/{st[2]}'), dtype='<f4')
    n = int(np.prod(size)); return a[off:off + n].reshape(size).copy()
W = tensor('ctc_decoder.decoder_layers.0.weight'); B = tensor('ctc_decoder.decoder_layers.0.bias'); print('head', W.shape, B.shape)
# the vocabulary must be the same, in the same order, as tokens.txt
cfg = yaml.safe_load(open('model_config.yaml', encoding='utf8')); voc = cfg['aux_ctc']['decoder']['vocabulary']
toks = [l.rsplit(' ', 1)[0] for l in open('tokens.txt', encoding='utf8').read().split('\n') if l]
assert toks[:len(voc)] == voc and toks[-1] == '<blk>' and len(toks) == len(voc) + 1, 'vocabulary differs'
m = onnx.load('encoder.onnx'); g = m.graph
enc = g.output[0].name  # N x 512 x T
g.initializer.extend([numpy_helper.from_array(W, 'ctc_w'), numpy_helper.from_array(B, 'ctc_b')])
g.node.extend([helper.make_node('Conv', [enc, 'ctc_w', 'ctc_b'], ['ctc_logits'], kernel_shape=[1]),
               helper.make_node('Transpose', ['ctc_logits'], ['ctc_logits_t'], perm=[0, 2, 1]),
               helper.make_node('LogSoftmax', ['ctc_logits_t'], ['logprobs'], axis=-1)])
lens = g.output[1]
del g.output[:]
g.output.extend([helper.make_tensor_value_info('logprobs', TensorProto.FLOAT, ['N', 'T', 1025]), lens])
del m.metadata_props[:]
for k, v in {'vocab_size': '1025', 'normalize_type': 'per_feature', 'subsampling_factor': '8', 'model_type': 'EncDecCTCModelBPE',
             'version': '1', 'model_author': 'NeMo', 'url': 'https://huggingface.co/nvidia/stt_ar_fastconformer_hybrid_large_pc_v1.0',
             'comment': 'CTC head of the hybrid model; CC-BY-4.0, NVIDIA'}.items():
    m.metadata_props.add(key=k, value=v)
onnx.save(m, 'model.onnx'); print('saved model.onnx')
if True:
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic('model.onnx', 'model.int8.onnx', weight_type=QuantType.QUInt8); print('saved model.int8.onnx')

import json
import sys
from pathlib import Path

import onnxruntime as ort
from gliner import GLiNER

request = json.load(sys.stdin)
model_path = Path(sys.argv[2])
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
model = GLiNER.from_pretrained(
    sys.argv[1],
    load_onnx_model=True,
    load_tokenizer=True,
    local_files_only=True,
    onnx_model_file=model_path.relative_to(sys.argv[1]).as_posix(),
    session=session,
)
results = []
for text in request["sentences"]:
    tokens, _, _ = model.prepare_inputs([text])
    encoded = model.data_processor.tokenize_inputs(tokens, request["labels"])
    results.append({
        "ids": encoded["input_ids"][0].tolist(),
        "wordsMask": encoded["words_mask"][0].tolist(),
        "spans": model.predict_entities(text, request["labels"], threshold=request["threshold"]),
    })
print(json.dumps(results))

import os
import cv2
import numpy as np

class FaceEnhancer:
    """
    GFPGAN ONNX Face Super-Resolution & Restoration Engine.
    Restores blurry 96x96 / low-res facial Visemes into sharp, photorealistic 512x512 textures.
    """
    def __init__(self, model_path="checkpoints/gfpgan_1.4.onnx"):
        self.model_path = model_path
        self.session = None

        if not os.path.exists(model_path):
            print(f"[FaceEnhancer] Warning: Model weights not found at {model_path}.")
            return

        try:
            import onnxruntime as ort
            providers = ['CPUExecutionProvider']
            # Tune thread settings for CPU
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 4
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

            self.session = ort.InferenceSession(model_path, sess_options=opts, providers=providers)
            self.input_name = self.session.get_inputs()[0].name
            self.output_name = self.session.get_outputs()[0].name
            print("[FaceEnhancer] GFPGAN ONNX Face Super-Resolution successfully loaded.")
        except Exception as e:
            print(f"[FaceEnhancer] Could not initialize ONNX session: {e}")
            self.session = None

    def is_available(self):
        return self.session is not None

    def enhance(self, face_bgr):
        """
        Takes a face crop (BGR), upscales/restores it to 512x512,
        and returns the enhanced face crop in BGR.
        """
        if self.session is None:
            return face_bgr

        orig_h, orig_w = face_bgr.shape[:2]

        # 1. Resize to 512x512 and convert BGR -> RGB
        face_rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
        input_512 = cv2.resize(face_rgb, (512, 512), interpolation=cv2.INTER_LANCZOS4)

        # 2. Normalize to [-1.0, 1.0] (Standard for GFPGAN)
        input_tensor = (input_512.astype(np.float32) / 255.0 - 0.5) / 0.5
        input_tensor = input_tensor.transpose((2, 0, 1))  # (3, 512, 512)
        input_tensor = np.expand_dims(input_tensor, axis=0)  # (1, 3, 512, 512)

        # 3. ONNX forward inference
        outputs = self.session.run([self.output_name], {self.input_name: input_tensor})
        output_tensor = outputs[0][0]  # (3, 512, 512)

        # 4. Denormalize back to [0, 255] uint8
        output_face = (output_tensor.transpose((1, 2, 0)) * 0.5 + 0.5) * 255.0
        output_face = np.clip(output_face, 0, 255).astype(np.uint8)

        # 5. Convert RGB -> BGR
        output_bgr = cv2.cvtColor(output_face, cv2.COLOR_RGB2BGR)

        # 6. Resize to original face crop dimensions
        restored_face = cv2.resize(output_bgr, (orig_w, orig_h), interpolation=cv2.INTER_LANCZOS4)
        return restored_face

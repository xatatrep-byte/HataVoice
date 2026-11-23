import { CAMERA_QUALITIES, CAMERA_QUALITY_LABELS, cameraLabel, type CameraFacing, type CameraQuality, type CameraSettings } from "../../voice/camera";
import { Segmented } from "../../ui/Segmented";
import { Select } from "../../ui/Select";
import { Toggle } from "../../ui/Toggle";

type Props = {
  camera: CameraSettings;
  /** The cameras of this PC (their names come once a camera was used). */
  devices: MediaDeviceInfo[];
  onChange: (change: Partial<CameraSettings>) => void;
  /** A phone: its cameras are the front and the back one. */
  phone?: boolean;
};

/** Which camera, how big, mirrored here or not: the same fields in the settings and by the camera button in a call. */
export function CameraFields({ camera, devices, onChange, phone = false }: Props) {
  const cameras = devices.filter((d) => d.deviceId && d.deviceId !== "default");
  const known = camera.deviceId === "default" || cameras.some((d) => d.deviceId === camera.deviceId);
  return (
    <>
      {phone ? (
        <Segmented<CameraFacing>
          label="Камера"
          value={camera.facing}
          options={[
            { value: "user", label: "Передняя" },
            { value: "environment", label: "Задняя" },
          ]}
          onChange={(facing) => onChange({ facing })}
        />
      ) : (
        <Select<string>
          label="Устройство"
          value={known ? camera.deviceId : "default"}
          options={[{ value: "default", label: "Как в Windows" }, ...cameras.map((d, i) => ({ value: d.deviceId, label: cameraLabel(d, i) }))]}
          onChange={(deviceId) => onChange({ deviceId })}
        />
      )}
      <Segmented<CameraQuality>
        label="Качество"
        value={camera.quality}
        options={CAMERA_QUALITIES.map((value) => ({ value, label: CAMERA_QUALITY_LABELS[value] }))}
        onChange={(quality) => onChange({ quality })}
      />
      <Toggle
        label="Зеркалить свою картинку"
        hint={phone ? "Только у тебя и только для передней камеры: друзья видят тебя как есть" : "Только у тебя: друзья видят тебя как есть"}
        checked={camera.mirror}
        onChange={(mirror) => onChange({ mirror })}
      />
    </>
  );
}

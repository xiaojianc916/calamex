// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#![cfg(all(windows, feature = "visual-hosting"))]

use std::sync::mpsc;

use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
use windows::{
  core::Interface,
  Win32::{
    Foundation::*,
    Graphics::{
      Direct3D::D3D_DRIVER_TYPE_HARDWARE,
      Direct3D11::{
        D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
      },
      DirectComposition::{
        DCompositionCreateDevice, IDCompositionDevice, IDCompositionRectangleClip,
        IDCompositionTarget, IDCompositionVisual,
      },
      Dxgi::IDXGIDevice,
      Gdi::ScreenToClient,
    },
    UI::{
      Accessibility::IRawElementProviderSimple,
      Input::Pointer::{
        GetPointerInfo, GetPointerPenInfo, GetPointerTouchInfo, POINTER_INFO, POINTER_PEN_INFO,
        POINTER_TOUCH_INFO,
      },
      WindowsAndMessaging::{GetClientRect, PT_PEN, PT_TOUCH, PT_TOUCHPAD},
    },
  },
};

use crate::Result;

use super::util;

#[derive(Clone)]
pub(crate) struct VisualHost {
  pub hwnd: HWND,
  #[allow(dead_code)]
  pub d3d: ID3D11Device,
  pub dcomp: IDCompositionDevice,
  #[allow(dead_code)]
  pub target: IDCompositionTarget,
  pub root_visual: IDCompositionVisual,
  #[allow(dead_code)]
  pub webview_visual: IDCompositionVisual,
  pub clip: IDCompositionRectangleClip,
  pub env3: ICoreWebView2Environment3,
  pub comp_controller: ICoreWebView2CompositionController,
  pub controller: ICoreWebView2Controller,
  pub automation_provider: Option<IRawElementProviderSimple>,
}

impl VisualHost {
  pub(crate) unsafe fn create(
    hwnd: HWND,
    env: &ICoreWebView2Environment,
    incognito: bool,
    background_color: Option<(u8, u8, u8, u8)>,
    bounds: RECT,
  ) -> Result<Self> {
    let mut d3d = None;
    // SAFETY: Called on the UI thread during WebView creation; WebView2 visual hosting requires
    // a BGRA-capable D3D11 device that stays alive for the lifetime of the composition tree.
    D3D11CreateDevice(
      None,
      D3D_DRIVER_TYPE_HARDWARE,
      HMODULE::default(),
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      None,
      D3D11_SDK_VERSION,
      Some(&mut d3d),
      None,
      None,
    )?;
    let d3d = d3d.ok_or_else(|| windows::core::Error::from(E_POINTER))?;

    let dxgi: IDXGIDevice = d3d.cast()?;
    // SAFETY: The DXGI device remains alive via `d3d`, satisfying DirectComposition's device lifetime.
    let dcomp: IDCompositionDevice = DCompositionCreateDevice(&dxgi)?;
    let target = dcomp.CreateTargetForHwnd(hwnd, false)?;
    let root_visual = dcomp.CreateVisual()?;
    let webview_visual = dcomp.CreateVisual()?;
    let clip = dcomp.CreateRectangleClip()?;

    root_visual.SetClip(&clip)?;
    target.SetRoot(&root_visual)?;
    root_visual.AddVisual(&webview_visual, true, None)?;

    let env3 = env.cast::<ICoreWebView2Environment3>()?;
    let comp_controller = create_composition_controller(env, hwnd, incognito, background_color)?;
    let controller: ICoreWebView2Controller = comp_controller.cast()?;
    comp_controller.SetRootVisualTarget(&webview_visual.cast::<windows::core::IUnknown>()?)?;
    let automation_provider = comp_controller
      .cast::<ICoreWebView2CompositionController2>()
      .ok()
      .and_then(|controller2| controller2.AutomationProvider().ok())
      .and_then(|provider| provider.cast::<IRawElementProviderSimple>().ok());

    let host = Self {
      hwnd,
      d3d,
      dcomp,
      target,
      root_visual,
      webview_visual,
      clip,
      env3,
      comp_controller,
      controller,
      automation_provider,
    };

    host.set_bounds(bounds)?;

    Ok(host)
  }

  pub(crate) unsafe fn resize(&self, width: i32, height: i32) -> Result<()> {
    self.set_bounds(RECT {
      left: 0,
      top: 0,
      right: width.max(0),
      bottom: height.max(0),
    })
  }

  pub(crate) unsafe fn set_bounds(&self, bounds: RECT) -> Result<()> {
    let width = (bounds.right - bounds.left).max(0) as f32;
    let height = (bounds.bottom - bounds.top).max(0) as f32;

    self.controller.SetBounds(bounds)?;
    self.root_visual.SetOffsetX2(bounds.left as f32)?;
    self.root_visual.SetOffsetY2(bounds.top as f32)?;
    self.clip.SetLeft2(0.0)?;
    self.clip.SetTop2(0.0)?;
    self.clip.SetRight2(width)?;
    self.clip.SetBottom2(height)?;
    self.dcomp.Commit()?;
    let _ = self.controller.NotifyParentWindowPositionChanged();

    Ok(())
  }

  pub(crate) unsafe fn on_dpi_changed(&self) -> Result<()> {
    if let Ok(controller3) = self.controller.cast::<ICoreWebView2Controller3>() {
      controller3.SetRasterizationScale(util::dpi_to_scale_factor(util::hwnd_dpi(self.hwnd)))?;
    }
    let _ = self.controller.NotifyParentWindowPositionChanged();

    Ok(())
  }

  pub(crate) unsafe fn create_pointer_info(
    &self,
    pointer_id: u32,
  ) -> Result<ICoreWebView2PointerInfo> {
    let mut info = POINTER_INFO::default();
    GetPointerInfo(pointer_id, &mut info)?;

    let mut client_rect = RECT::default();
    GetClientRect(self.hwnd, &mut client_rect)?;

    let pixel_location = screen_point_to_client(self.hwnd, info.ptPixelLocation)?;
    let pixel_location_raw = screen_point_to_client(self.hwnd, info.ptPixelLocationRaw)?;

    let pointer_info = self.env3.CreateCoreWebView2PointerInfo()?;
    pointer_info.SetPointerKind(info.pointerType.0 as u32)?;
    pointer_info.SetPointerId(info.pointerId)?;
    pointer_info.SetFrameId(info.frameId)?;
    pointer_info.SetPointerFlags(info.pointerFlags.0)?;
    pointer_info.SetDisplayRect(client_rect)?;
    pointer_info.SetPointerDeviceRect(client_rect)?;
    pointer_info.SetPixelLocation(pixel_location)?;
    pointer_info.SetPixelLocationRaw(pixel_location_raw)?;
    pointer_info.SetTime(info.dwTime)?;
    pointer_info.SetHistoryCount(info.historyCount)?;
    pointer_info.SetInputData(info.InputData)?;
    pointer_info.SetKeyStates(info.dwKeyStates)?;
    pointer_info.SetPerformanceCount(info.PerformanceCount)?;
    pointer_info.SetButtonChangeKind(info.ButtonChangeType.0)?;

    match info.pointerType {
      PT_TOUCH | PT_TOUCHPAD => {
        let mut touch_info = POINTER_TOUCH_INFO::default();
        if GetPointerTouchInfo(pointer_id, &mut touch_info).is_ok() {
          pointer_info.SetTouchFlags(touch_info.touchFlags)?;
          pointer_info.SetTouchMask(touch_info.touchMask)?;
          pointer_info.SetTouchContact(screen_rect_to_client(self.hwnd, touch_info.rcContact)?)?;
          pointer_info
            .SetTouchContactRaw(screen_rect_to_client(self.hwnd, touch_info.rcContactRaw)?)?;
          pointer_info.SetTouchOrientation(touch_info.orientation)?;
          pointer_info.SetTouchPressure(touch_info.pressure)?;
        }
      }
      PT_PEN => {
        let mut pen_info = POINTER_PEN_INFO::default();
        if GetPointerPenInfo(pointer_id, &mut pen_info).is_ok() {
          pointer_info.SetPenFlags(pen_info.penFlags)?;
          pointer_info.SetPenMask(pen_info.penMask)?;
          pointer_info.SetPenPressure(pen_info.pressure)?;
          pointer_info.SetPenRotation(pen_info.rotation)?;
          pointer_info.SetPenTiltX(pen_info.tiltX)?;
          pointer_info.SetPenTiltY(pen_info.tiltY)?;
        }
      }
      _ => {}
    }

    Ok(pointer_info)
  }
}

unsafe fn create_composition_controller(
  env: &ICoreWebView2Environment,
  hwnd: HWND,
  incognito: bool,
  background_color: Option<(u8, u8, u8, u8)>,
) -> Result<ICoreWebView2CompositionController> {
  let (tx, rx) = mpsc::channel();

  let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(
    move |error_code, controller| {
      let result = (|| {
        error_code?;
        controller.ok_or_else(|| windows::core::Error::from(E_POINTER).into())
      })();
      tx.send(result)
        .map_err(|_| windows::core::Error::from(E_UNEXPECTED))
    },
  ));

  if let Ok(env10) = env.cast::<ICoreWebView2Environment10>() {
    let controller_opts = env10.CreateCoreWebView2ControllerOptions()?;

    if let Some((r, g, b, mut a)) = background_color {
      if let Ok(opts3) = controller_opts.cast::<ICoreWebView2ControllerOptions3>() {
        if a != 0 {
          a = 255;
        }
        opts3.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
          R: r,
          G: g,
          B: b,
          A: a,
        })?;
      }
    }

    controller_opts.SetIsInPrivateModeEnabled(incognito)?;
    env10.CreateCoreWebView2CompositionControllerWithOptions(hwnd, &controller_opts, &handler)?;
  } else {
    let env3 = env.cast::<ICoreWebView2Environment3>()?;
    env3.CreateCoreWebView2CompositionController(hwnd, &handler)?;
  }

  webview2_com::wait_with_pump(rx)?
}

unsafe fn screen_point_to_client(hwnd: HWND, mut point: POINT) -> Result<POINT> {
  if !ScreenToClient(hwnd, &mut point).as_bool() {
    return Err(windows::core::Error::from_win32().into());
  }
  Ok(point)
}

unsafe fn screen_rect_to_client(hwnd: HWND, rect: RECT) -> Result<RECT> {
  let mut top_left = POINT {
    x: rect.left,
    y: rect.top,
  };
  let mut bottom_right = POINT {
    x: rect.right,
    y: rect.bottom,
  };

  if !ScreenToClient(hwnd, &mut top_left).as_bool() {
    return Err(windows::core::Error::from_win32().into());
  }
  if !ScreenToClient(hwnd, &mut bottom_right).as_bool() {
    return Err(windows::core::Error::from_win32().into());
  }

  Ok(RECT {
    left: top_left.x,
    top: top_left.y,
    right: bottom_right.x,
    bottom: bottom_right.y,
  })
}

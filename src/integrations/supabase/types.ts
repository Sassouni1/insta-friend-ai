export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bookings: {
        Row: {
          caller_email: string | null
          caller_name: string | null
          caller_phone: string | null
          conversation_id: string | null
          created_at: string
          ghl_appointment_id: string | null
          id: string
          slot_iso: string
          status: string
          tenant_id: string
        }
        Insert: {
          caller_email?: string | null
          caller_name?: string | null
          caller_phone?: string | null
          conversation_id?: string | null
          created_at?: string
          ghl_appointment_id?: string | null
          id?: string
          slot_iso: string
          status?: string
          tenant_id: string
        }
        Update: {
          caller_email?: string | null
          caller_name?: string | null
          caller_phone?: string | null
          conversation_id?: string | null
          created_at?: string
          ghl_appointment_id?: string | null
          id?: string
          slot_iso?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          agent_id: string | null
          caller_phone: string | null
          created_at: string
          direction: string
          ended_at: string | null
          first_inbound_speech_at: string | null
          id: string
          inbound_speech_frame_count: number
          media_frame_count: number
          started_at: string
          telnyx_answered_at: string | null
          telnyx_call_control_id: string | null
          telnyx_call_leg_id: string | null
          telnyx_call_session_id: string | null
          telnyx_call_status: string | null
          telnyx_event_payload: Json | null
          telnyx_hangup_cause: string | null
          telnyx_hangup_source: string | null
          telnyx_sip_code: number | null
          tenant_id: string | null
        }
        Insert: {
          agent_id?: string | null
          caller_phone?: string | null
          created_at?: string
          direction?: string
          ended_at?: string | null
          first_inbound_speech_at?: string | null
          id?: string
          inbound_speech_frame_count?: number
          media_frame_count?: number
          started_at?: string
          telnyx_answered_at?: string | null
          telnyx_call_control_id?: string | null
          telnyx_call_leg_id?: string | null
          telnyx_call_session_id?: string | null
          telnyx_call_status?: string | null
          telnyx_event_payload?: Json | null
          telnyx_hangup_cause?: string | null
          telnyx_hangup_source?: string | null
          telnyx_sip_code?: number | null
          tenant_id?: string | null
        }
        Update: {
          agent_id?: string | null
          caller_phone?: string | null
          created_at?: string
          direction?: string
          ended_at?: string | null
          first_inbound_speech_at?: string | null
          id?: string
          inbound_speech_frame_count?: number
          media_frame_count?: number
          started_at?: string
          telnyx_answered_at?: string | null
          telnyx_call_control_id?: string | null
          telnyx_call_leg_id?: string | null
          telnyx_call_session_id?: string | null
          telnyx_call_status?: string | null
          telnyx_event_payload?: Json | null
          telnyx_hangup_cause?: string | null
          telnyx_hangup_source?: string | null
          telnyx_sip_code?: number | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          state: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          state: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      phone_numbers: {
        Row: {
          active: boolean
          created_at: string
          e164_number: string
          id: string
          telnyx_connection_id: string | null
          tenant_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          e164_number: string
          id?: string
          telnyx_connection_id?: string | null
          tenant_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          e164_number?: string
          id?: string
          telnyx_connection_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_calls: {
        Row: {
          attempts: number
          conversation_id: string | null
          created_at: string
          fire_at: string
          ghl_contact_id: string | null
          id: string
          last_error: string | null
          lead_email: string | null
          lead_name: string | null
          lead_phone: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          conversation_id?: string | null
          created_at?: string
          fire_at: string
          ghl_contact_id?: string | null
          id?: string
          last_error?: string | null
          lead_email?: string | null
          lead_name?: string | null
          lead_phone: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          conversation_id?: string | null
          created_at?: string
          fire_at?: string
          ghl_contact_id?: string | null
          id?: string
          last_error?: string | null
          lead_email?: string | null
          lead_name?: string | null
          lead_phone?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_calls_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_calls_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          active: boolean
          created_at: string
          ghl_api_token: string | null
          ghl_calendar_id: string | null
          ghl_company_id: string | null
          ghl_location_id: string | null
          ghl_refresh_token: string | null
          ghl_token_expires_at: string | null
          id: string
          name: string
          oauth_imported: boolean
          timezone: string
          updated_at: string
          webhook_secret: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          ghl_api_token?: string | null
          ghl_calendar_id?: string | null
          ghl_company_id?: string | null
          ghl_location_id?: string | null
          ghl_refresh_token?: string | null
          ghl_token_expires_at?: string | null
          id?: string
          name: string
          oauth_imported?: boolean
          timezone?: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          ghl_api_token?: string | null
          ghl_calendar_id?: string | null
          ghl_company_id?: string | null
          ghl_location_id?: string | null
          ghl_refresh_token?: string | null
          ghl_token_expires_at?: string | null
          id?: string
          name?: string
          oauth_imported?: boolean
          timezone?: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Relationships: []
      }
      transcript_entries: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          response_latency_ms: number | null
          role: string
          spoken_at: string
          text: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          response_latency_ms?: number | null
          role: string
          spoken_at?: string
          text: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          response_latency_ms?: number | null
          role?: string
          spoken_at?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "transcript_entries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin"],
    },
  },
} as const
